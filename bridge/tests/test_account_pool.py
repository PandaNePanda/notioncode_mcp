from __future__ import annotations

import asyncio
import json
import tempfile
import time
import unittest
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
from notion_agent_cli.exceptions import ErrorCode, NotionAgentError

import account_pool
from account_pool import (
    MAX_REASONING_EFFORT,
    UNHEALTHY_ACCOUNT_COOLDOWN,
    AccountPoolExhausted,
    NotionAccountPool,
    MaxEffortNotionAgentClient,
    build_account_pool,
    discover_account_paths,
)


class FakeClient:
    def __init__(self, name: str) -> None:
        self.name = name
        self.closed = False

    async def aclose(self) -> None:
        self.closed = True


class RevalidationClient(FakeClient):
    def __init__(self, name: str, result: object | Exception) -> None:
        super().__init__(name)
        self.result = result
        self.calls: list[dict[str, object]] = []

    async def complete(self, **kwargs: object) -> object:
        self.calls.append(kwargs)
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


@dataclass
class FakeAccount:
    client_version: str


class AccountPoolTests(unittest.IsolatedAsyncioTestCase):
    async def test_required_model_routes_only_to_an_account_that_advertised_it(self) -> None:
        old = FakeClient("old")
        future = FakeClient("future")
        old._notion_available_model_aliases = frozenset({"gpt-5.6-sol"})
        future._notion_available_model_aliases = frozenset({"gpt-5.6-sol", "gpt-6.0-pro"})
        pool = NotionAccountPool([old, future], account_ids=["old", "future"])

        async with pool.lease(required_model="gpt-6.0-pro") as lease:
            self.assertEqual(lease.account_id, "future")

    async def test_pre_refresh_pool_does_not_reject_a_selected_model(self) -> None:
        pool = NotionAccountPool([FakeClient("one")], account_ids=["one"])
        async with pool.lease(required_model="gpt-6.0-pro") as lease:
            self.assertEqual(lease.account_id, "one")

    def test_prepare_call_writes_request_reasoning_effort(self) -> None:
        client = object.__new__(MaxEffortNotionAgentClient)
        prepared = SimpleNamespace(
            body={"transcript": [{"type": "config", "value": {}}]},
        )
        with patch.object(
            account_pool.NotionAgentClient,
            "_prepare_call",
            return_value=prepared,
        ):
            result = client._prepare_call(
                reasoning_effort="max",
                service_tier="PRIORITY",
            )

        self.assertIs(result, prepared)
        self.assertEqual(
            prepared.body["transcript"][0]["value"]["reasoningEffort"],
            "max",
        )
        self.assertEqual(
            prepared.body["transcript"][0]["value"]["serviceTier"],
            "priority",
        )

    def test_prepare_call_invalid_or_missing_effort_falls_back_safely(self) -> None:
        client = object.__new__(MaxEffortNotionAgentClient)
        for effort in (None, "unsupported", ""):
            prepared = SimpleNamespace(
                body={"transcript": [{"type": "config", "value": {}}]},
            )
            with patch.object(
                account_pool.NotionAgentClient,
                "_prepare_call",
                return_value=prepared,
            ):
                kwargs = {} if effort is None else {"reasoning_effort": effort}
                client._prepare_call(**kwargs)
            self.assertEqual(
                prepared.body["transcript"][0]["value"]["reasoningEffort"],
                MAX_REASONING_EFFORT,
            )

    async def test_concurrent_request_efforts_do_not_leak(self) -> None:
        client = object.__new__(MaxEffortNotionAgentClient)
        client._client_version_checked_at = time.monotonic()
        entered = 0
        both_entered = asyncio.Event()

        async def fake_complete(_client, *args, **kwargs):
            nonlocal entered
            entered += 1
            if entered == 2:
                both_entered.set()
            await asyncio.wait_for(both_entered.wait(), timeout=1)
            await asyncio.sleep(0)
            return account_pool._REQUEST_REASONING_EFFORT.get()

        with patch.object(
            account_pool.NotionAgentClient,
            "complete",
            new=fake_complete,
        ):
            low, maximum = await asyncio.gather(
                client.complete(reasoning_effort="low"),
                client.complete(reasoning_effort="max"),
            )

        self.assertEqual((low, maximum), ("low", "max"))
        self.assertIsNone(account_pool._REQUEST_REASONING_EFFORT.get())

    async def test_empty_patch_response_does_not_use_model_substituting_legacy_mode(self) -> None:
        client = MaxEffortNotionAgentClient(
            None,
            account=FakeAccount(client_version="23.13.20260729.0607"),
        )
        client._client_version_checked_at = time.monotonic()
        modes = []

        async def fake_complete(current, *args, **kwargs):
            modes.append((current.as_patch_response, account_pool._REQUEST_REASONING_EFFORT.get()))
            raise NotionAgentError("empty patch response", code=ErrorCode.EMPTY_TEXT)

        with patch.object(account_pool.NotionAgentClient, "complete", new=fake_complete):
            with self.assertRaises(NotionAgentError):
                await client.complete(reasoning_effort="high")

        self.assertEqual(modes, [(True, "high")])
        self.assertIsNone(account_pool._REQUEST_REASONING_EFFORT.get())
        await client.aclose()

    async def test_non_empty_error_does_not_use_legacy_mode(self) -> None:
        client = MaxEffortNotionAgentClient(
            None,
            account=FakeAccount(client_version="23.13.20260729.0607"),
        )
        client._client_version_checked_at = time.monotonic()
        modes = []

        async def fake_complete(current, *args, **kwargs):
            modes.append(current.as_patch_response)
            raise NotionAgentError("HTTP 403", code=ErrorCode.HTTP_ERROR)

        with patch.object(account_pool.NotionAgentClient, "complete", new=fake_complete):
            with self.assertRaises(NotionAgentError):
                await client.complete(reasoning_effort="low")

        self.assertEqual(modes, [True])
        await client.aclose()

    async def test_explicit_legacy_client_is_not_retried(self) -> None:
        client = MaxEffortNotionAgentClient(
            None,
            account=FakeAccount(client_version="23.13.20260729.0607"),
            as_patch_response=False,
        )
        client._client_version_checked_at = time.monotonic()
        modes = []

        async def fake_complete(current, *args, **kwargs):
            modes.append(current.as_patch_response)
            raise NotionAgentError("empty response", code=ErrorCode.EMPTY_TEXT)

        with patch.object(account_pool.NotionAgentClient, "complete", new=fake_complete):
            with self.assertRaises(NotionAgentError):
                await client.complete(reasoning_effort="max")

        self.assertEqual(modes, [False])
        await client.aclose()

    async def test_refreshes_stale_client_version_before_inference(self) -> None:
        client = MaxEffortNotionAgentClient(
            None,
            account=FakeAccount(client_version="23.13.20260101.0000"),
        )
        with patch(
            "account_pool.fetch_live_client_version",
            new=AsyncMock(return_value="23.13.20260724.2104"),
        ):
            await client._refresh_client_version_if_needed()

        self.assertEqual(client.load_account().client_version, "23.13.20260724.2104")
        await client.aclose()

    async def test_times_out_runaway_inference_and_releases_account(self) -> None:
        pool = NotionAccountPool([FakeClient("one")], account_ids=["one"])

        async def operation(_client: FakeClient) -> str:
            await asyncio.sleep(1)
            return "late"

        with patch("account_pool.INFERENCE_TIMEOUT_SECONDS", 0.01):
            with self.assertLogs("uvicorn.error.notion_pool", level="WARNING") as captured:
                async with pool.lease() as lease:
                    with self.assertRaisesRegex(
                        TimeoutError,
                        "Notion inference exceeded 0.01 seconds",
                    ):
                        await lease.run(operation)

        status = await pool.status()
        events = [json.loads(record.getMessage()) for record in captured.records]
        self.assertEqual(events[-1]["event"], "account_request_timed_out")
        self.assertEqual(status["busy"], 0)
        self.assertEqual(status["available"], 1)

    async def test_emits_structured_account_lifecycle_events(self) -> None:
        pool = NotionAccountPool(
            [FakeClient("one"), FakeClient("two")],
            account_ids=["one", "two"],
        )

        async def operation(client: FakeClient) -> str:
            if client.name == "one":
                raise NotionAgentError("HTTP 502", code=ErrorCode.HTTP_ERROR)
            return "ok"

        with self.assertLogs("uvicorn.error.notion_pool", level="INFO") as captured:
            async with pool.lease() as lease:
                self.assertEqual(await lease.run(operation), "ok")

        events = [json.loads(record.getMessage()) for record in captured.records]
        self.assertEqual(
            [event["event"] for event in events],
            [
                "account_selected",
                "account_request_failed",
                "account_selected",
                "account_failover",
                "account_request_succeeded",
            ],
        )
        self.assertEqual(events[0]["account_id"], "one")
        self.assertEqual(events[1]["error_code"], ErrorCode.HTTP_ERROR)
        self.assertEqual(events[2]["selection"], "failover")
        self.assertEqual(events[3]["to_account_id"], "two")
        self.assertEqual(events[4]["account_id"], "two")

    async def test_leases_accounts_in_round_robin_order(self) -> None:
        clients = [FakeClient("one"), FakeClient("two"), FakeClient("three")]
        pool = NotionAccountPool(clients)

        selected = []
        for _ in range(4):
            async with pool.lease() as lease:
                selected.append(lease.client.name)

        self.assertEqual(selected, ["one", "two", "three", "one"])

    async def test_ten_accounts_are_all_used_before_rotation_repeats(self) -> None:
        clients = [FakeClient(f"account-{index:02d}") for index in range(1, 11)]
        pool = NotionAccountPool(
            clients,
            account_ids=[client.name for client in clients],
        )
        selected = []
        for _ in range(11):
            async with pool.lease() as lease:
                selected.append(lease.account_id)
        self.assertEqual(selected[:10], [client.name for client in clients])
        self.assertEqual(selected[10], "account-01")

    async def test_one_account_serializes_concurrent_requests(self) -> None:
        pool = NotionAccountPool([FakeClient("one")])
        first_entered = asyncio.Event()
        release_first = asyncio.Event()
        order = []

        async def first() -> None:
            async with pool.lease():
                order.append("first-start")
                first_entered.set()
                await release_first.wait()
                order.append("first-end")

        async def second() -> None:
            await first_entered.wait()
            async with pool.lease():
                order.append("second-start")

        first_task = asyncio.create_task(first())
        second_task = asyncio.create_task(second())
        await first_entered.wait()
        await asyncio.sleep(0)
        self.assertEqual(order, ["first-start"])
        release_first.set()
        await asyncio.gather(first_task, second_task)

        self.assertEqual(order, ["first-start", "first-end", "second-start"])

    async def test_concurrent_requests_use_different_accounts(self) -> None:
        pool = NotionAccountPool([FakeClient("one"), FakeClient("two")])
        both_entered = asyncio.Event()
        release = asyncio.Event()
        active = []

        async def request() -> None:
            async with pool.lease() as lease:
                active.append(lease.client.name)
                if len(active) == 2:
                    both_entered.set()
                await release.wait()

        tasks = [asyncio.create_task(request()) for _ in range(2)]
        await asyncio.wait_for(both_entered.wait(), timeout=1)
        self.assertCountEqual(active, ["one", "two"])
        release.set()
        await asyncio.gather(*tasks)

    async def test_affinity_prefers_same_account_without_advancing_new_turn_fairness(self) -> None:
        pool = NotionAccountPool(
            [FakeClient("one"), FakeClient("two"), FakeClient("three")],
            account_ids=["one", "two", "three"],
        )
        async with pool.lease() as first:
            self.assertEqual(first.account_id, "one")
        async with pool.lease(preferred_account_id="one") as continued:
            self.assertEqual(continued.account_id, "one")
        async with pool.lease() as next_turn:
            self.assertEqual(next_turn.account_id, "two")

    async def test_scheduler_state_survives_restart(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            state = Path(temporary_directory) / "pool-state.json"
            pool = NotionAccountPool(
                [FakeClient("one"), FakeClient("two")],
                account_ids=["one", "two"],
                state_path=state,
            )
            async with pool.lease() as lease:
                self.assertEqual(lease.account_id, "one")
            restarted = NotionAccountPool(
                [FakeClient("one"), FakeClient("two")],
                account_ids=["one", "two"],
                state_path=state,
            )
            async with restarted.lease() as lease:
                self.assertEqual(lease.account_id, "two")

    async def test_cooldown_account_is_skipped(self) -> None:
        pool = NotionAccountPool(
            [FakeClient("one"), FakeClient("two")],
            account_ids=["one", "two"],
        )
        pool._slots[0].cooldown_until = time.time() + 60
        async with pool.lease() as lease:
            self.assertEqual(lease.account_id, "two")

    async def test_new_turn_avoidance_rotates_but_keeps_a_ready_fallback(self) -> None:
        pool = NotionAccountPool(
            [FakeClient("one"), FakeClient("two")],
            account_ids=["one", "two"],
        )

        async with pool.lease(avoid_account_id="one") as rotated:
            self.assertEqual(rotated.account_id, "two")

        pool._slots[1].cooldown_until = time.time() + 60
        async with pool.lease(avoid_account_id="one") as fallback:
            self.assertEqual(fallback.account_id, "one")

    async def test_retries_on_next_account_after_notion_failure(self) -> None:
        pool = NotionAccountPool([FakeClient("one"), FakeClient("two")])
        attempts = []

        async def operation(client: FakeClient) -> str:
            attempts.append(client.name)
            if client.name == "one":
                raise NotionAgentError("HTTP 502", code=ErrorCode.HTTP_ERROR)
            return "ok"

        async with pool.lease() as lease:
            result = await lease.run(operation)

        self.assertEqual(result, "ok")
        self.assertEqual(attempts, ["one", "two"])

    async def test_open_global_breaker_does_not_delay_ready_failover(self) -> None:
        pool = NotionAccountPool(
            [FakeClient("one"), FakeClient("two"), FakeClient("three")],
            account_ids=["one", "two", "three"],
        )
        now = time.time()
        pool._recent_failures.extend([
            (now, "two", "notion_error:error"),
            (now, "three", "notion_error:error"),
        ])
        attempts = []

        async def operation(client: FakeClient) -> str:
            attempts.append(client.name)
            if client.name == "one":
                raise NotionAgentError(
                    "temporary Notion failure",
                    code=ErrorCode.NOTION_ERROR,
                    subtype="error",
                    retryable=True,
                )
            return "ok"

        started = time.monotonic()
        with patch("account_pool.TRANSIENT_FAILOVER_COOLDOWN", 2):
            async with pool.lease() as lease:
                result = await lease.run(operation)

        self.assertEqual(result, "ok")
        self.assertEqual(attempts, ["one", "two"])
        self.assertLess(time.monotonic() - started, 0.5)

    async def test_empty_text_fails_over_and_quarantines_bad_account(self) -> None:
        pool = NotionAccountPool(
            [FakeClient("empty"), FakeClient("healthy")],
            account_ids=["empty", "healthy"],
        )
        attempts = []

        async def operation(client: FakeClient) -> str:
            attempts.append(client.name)
            if client.name == "empty":
                raise NotionAgentError("empty response", code=ErrorCode.EMPTY_TEXT)
            return "ok"

        async with pool.lease() as lease:
            self.assertEqual(await lease.run(operation), "ok")

        self.assertEqual(attempts, ["empty", "healthy"])
        self.assertGreaterEqual(pool._slots[0].cooldown_until - time.time(), 59)
        async with pool.lease() as lease:
            self.assertEqual(lease.account_id, "healthy")

    async def test_persistently_unhealthy_account_gets_long_quarantine(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            state = Path(temporary_directory) / "pool-state.json"
            pool = NotionAccountPool(
                [FakeClient("unhealthy"), FakeClient("healthy")],
                account_ids=["unhealthy", "healthy"],
                state_path=state,
            )
            unhealthy = pool._slots[0]
            unhealthy.successes = 2
            unhealthy.failures = 7

            async def operation(client: FakeClient) -> str:
                if client.name == "unhealthy":
                    raise NotionAgentError("empty response", code=ErrorCode.EMPTY_TEXT)
                return "ok"

            async with pool.lease(preferred_account_id="unhealthy") as lease:
                self.assertEqual(await lease.run(operation), "ok")

            self.assertGreaterEqual(
                unhealthy.cooldown_until - time.time(),
                UNHEALTHY_ACCOUNT_COOLDOWN - 1,
            )
            restarted = NotionAccountPool(
                [FakeClient("unhealthy"), FakeClient("healthy")],
                account_ids=["unhealthy", "healthy"],
                state_path=state,
            )
            self.assertGreaterEqual(
                restarted._slots[0].cooldown_until - time.time(),
                UNHEALTHY_ACCOUNT_COOLDOWN - 1,
            )

    async def test_reliability_beats_raw_latency_for_new_turns(self) -> None:
        pool = NotionAccountPool(
            [FakeClient("unreliable-fast"), FakeClient("healthy")],
            account_ids=["unreliable-fast", "healthy"],
        )
        unreliable, healthy = pool._slots
        unreliable.latency_ewma_ms = 1000
        unreliable.latency_samples = 5
        unreliable.successes = 5
        unreliable.failures = 20
        healthy.latency_ewma_ms = 10000
        healthy.latency_samples = 5
        healthy.successes = 20
        healthy.failures = 1

        async with pool.lease() as lease:
            self.assertEqual(lease.account_id, "healthy")

    async def test_latency_beats_small_failure_difference_between_healthy_accounts(self) -> None:
        pool = NotionAccountPool(
            [FakeClient("fast"), FakeClient("slow-perfect")],
            account_ids=["fast", "slow-perfect"],
        )
        fast, slow = pool._slots
        fast.latency_ewma_ms = 8000
        fast.latency_samples = 100
        fast.successes = 101
        fast.failures = 14
        slow.latency_ewma_ms = 17000
        slow.latency_samples = 8
        slow.successes = 8
        slow.failures = 0

        async with pool.lease() as lease:
            self.assertEqual(lease.account_id, "fast")

    async def test_non_retryable_denial_puts_account_in_long_cooldown(self) -> None:
        pool = NotionAccountPool([FakeClient("one"), FakeClient("two")])

        async def operation(client: FakeClient) -> str:
            if client.name == "one":
                raise NotionAgentError(
                    "temporarily unavailable",
                    code=ErrorCode.NOTION_ERROR,
                    subtype="temporarily-unavailable",
                    retryable=False,
                )
            return "ok"

        async with pool.lease() as lease:
            self.assertEqual(await lease.run(operation), "ok")

        self.assertGreaterEqual(pool._slots[0].cooldown_until - time.time(), 299)

    async def test_recovery_operation_replaces_thread_continuation(self) -> None:
        pool = NotionAccountPool([FakeClient("one"), FakeClient("two")])
        attempts = []

        async def continuation(client: FakeClient) -> str:
            attempts.append((client.name, "continuation"))
            raise NotionAgentError("HTTP 502", code=ErrorCode.HTTP_ERROR)

        async def recovery(client: FakeClient) -> str:
            attempts.append((client.name, "recovery"))
            return "recovered"

        async with pool.lease() as lease:
            result = await lease.run(continuation, retry_operation=recovery)

        self.assertEqual(result, "recovered")
        self.assertEqual(attempts, [("one", "continuation"), ("two", "recovery")])

    async def test_reports_failure_after_each_account_was_attempted_once(self) -> None:
        pool = NotionAccountPool([FakeClient("one"), FakeClient("two")])
        attempts = []

        async def operation(client: FakeClient) -> str:
            attempts.append(client.name)
            raise NotionAgentError("HTTP 502", code=ErrorCode.HTTP_ERROR)

        with patch("account_pool.POOL_RECOVERY_WAIT_SECONDS", 0):
            with self.assertRaisesRegex(AccountPoolExhausted, "All 2 Notion accounts failed"):
                async with pool.lease() as lease:
                    await lease.run(operation)

        self.assertEqual(attempts, ["one", "two"])
        status = await pool.status()
        self.assertEqual(status["busy"], 0)

    async def test_transient_failure_waits_and_retries_without_visible_cooldown(self) -> None:
        pool = NotionAccountPool([FakeClient("one")], account_ids=["one"])
        attempts = 0

        async def operation(_client: FakeClient) -> str:
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise httpx.ConnectError("temporary upstream failure")
            return "ok"

        with (
            patch("account_pool.DEFAULT_TRANSIENT_COOLDOWN", 0.01),
            patch("account_pool.POOL_RECOVERY_WAIT_SECONDS", 0.2),
        ):
            async with pool.lease() as lease:
                result = await lease.run(operation)

        self.assertEqual(result, "ok")
        self.assertEqual(attempts, 2)

    async def test_disabled_account_does_not_block_eligible_retry_cycle(self) -> None:
        pool = NotionAccountPool(
            [FakeClient("one"), FakeClient("two"), FakeClient("disabled")],
            account_ids=["one", "two", "disabled"],
        )
        pool._slots[2].disabled = True
        pool._slots[2].last_error_code = "ModelIntegrityError"
        attempts = []

        async def operation(client: FakeClient) -> str:
            attempts.append(client.name)
            if len(attempts) <= 2:
                raise NotionAgentError(
                    "temporary Notion failure",
                    code=ErrorCode.NOTION_ERROR,
                    subtype="error",
                    retryable=True,
                )
            return "ok"

        with (
            patch("account_pool.TRANSIENT_FAILOVER_COOLDOWN", 0.01),
            patch("account_pool.POOL_RECOVERY_WAIT_SECONDS", 0.2),
        ):
            async with pool.lease() as lease:
                result = await lease.run(operation)

        self.assertEqual(result, "ok")
        self.assertEqual(attempts[:2], ["one", "two"])
        self.assertEqual(len(attempts), 3)
        self.assertNotIn("disabled", attempts)

    async def test_retryable_notion_error_uses_short_interactive_cooldown(self) -> None:
        pool = NotionAccountPool(
            [FakeClient("one"), FakeClient("two"), FakeClient("three")],
            account_ids=["one", "two", "three"],
        )
        attempts = 0

        async def operation(_client: FakeClient) -> str:
            nonlocal attempts
            attempts += 1
            if attempts <= 3:
                raise NotionAgentError(
                    "temporary Notion failure",
                    code=ErrorCode.NOTION_ERROR,
                    retryable=True,
                )
            return "ok"

        with (
            patch("account_pool.TRANSIENT_FAILOVER_COOLDOWN", 0.01),
            patch("account_pool.POOL_RECOVERY_WAIT_SECONDS", 0.2),
            patch("account_pool.MAX_RECOVERY_CYCLES", 1),
        ):
            async with pool.lease() as lease:
                result = await lease.run(operation)

        self.assertEqual(result, "ok")
        self.assertEqual(attempts, 4)
        self.assertTrue(all(
            slot.cooldown_until - time.time() < 0.1
            for slot in pool._slots
        ))

    async def test_single_account_repeated_failure_is_bounded_to_one_fast_retry(self) -> None:
        pool = NotionAccountPool([FakeClient("one")], account_ids=["one"])
        attempts = 0

        async def operation(_client: FakeClient) -> str:
            nonlocal attempts
            attempts += 1
            raise NotionAgentError(
                "temporary Notion failure",
                code=ErrorCode.NOTION_ERROR,
                retryable=True,
            )

        with (
            patch("account_pool.SINGLE_ACCOUNT_TRANSIENT_COOLDOWN", 0.01),
            patch("account_pool.POOL_RECOVERY_WAIT_SECONDS", 0.2),
            patch("account_pool.MAX_RECOVERY_CYCLES", 1),
        ):
            with self.assertRaises(AccountPoolExhausted):
                async with pool.lease() as lease:
                    await lease.run(operation)

        self.assertEqual(attempts, 2)

    async def test_local_validation_error_does_not_switch_accounts(self) -> None:
        pool = NotionAccountPool([FakeClient("one"), FakeClient("two")])
        attempts = []

        async def operation(client: FakeClient) -> str:
            attempts.append(client.name)
            raise NotionAgentError("empty prompt", code=ErrorCode.EMPTY_PROMPT)

        with self.assertRaises(NotionAgentError):
            async with pool.lease() as lease:
                await lease.run(operation)

        self.assertEqual(attempts, ["one"])

    async def test_new_turns_prefer_measured_faster_account(self) -> None:
        pool = NotionAccountPool(
            [FakeClient("slow"), FakeClient("fast")],
            account_ids=["slow", "fast"],
        )

        # Both accounts are explored before latency routing starts.
        async with pool.lease() as slow:
            self.assertEqual(slow.account_id, "slow")
            await slow.run(lambda _client: asyncio.sleep(0, result="ok"))
        async with pool.lease() as fast:
            self.assertEqual(fast.account_id, "fast")
            await fast.run(lambda _client: asyncio.sleep(0, result="ok"))

        pool._slots[0].latency_ewma_ms = 15000
        pool._slots[0].latency_samples = 5
        pool._slots[1].latency_ewma_ms = 9000
        pool._slots[1].latency_samples = 5
        # The exploratory lease calls above also create default-tier and
        # default:ultra profile samples with near-zero synthetic asyncio.sleep
        # latency. Clear both layers so this legacy-routing assertion
        # specifically verifies the intended overall-latency fallback.
        for slot in pool._slots:
            slot.tier_latency_ewma_ms.clear()
            slot.tier_latency_samples.clear()
            slot.profile_latency_ewma_ms.clear()
            slot.profile_latency_samples.clear()

        async with pool.lease() as selected:
            self.assertEqual(selected.account_id, "fast")

        # Thread affinity remains stronger than the latency preference.
        async with pool.lease(preferred_account_id="slow") as continued:
            self.assertEqual(continued.account_id, "slow")

    async def test_speed_tiers_route_by_independent_latency_profiles(self) -> None:
        pool = NotionAccountPool(
            [FakeClient("standard-fast"), FakeClient("priority-fast")],
            account_ids=["standard-fast", "priority-fast"],
        )
        first, second = pool._slots
        first.latency_ewma_ms = 5000
        first.latency_samples = 4
        second.latency_ewma_ms = 5000
        second.latency_samples = 4
        first.tier_latency_ewma_ms = {"default": 2000, "priority": 9000}
        first.tier_latency_samples = {"default": 3, "priority": 3}
        second.tier_latency_ewma_ms = {"default": 8000, "priority": 2500}
        second.tier_latency_samples = {"default": 3, "priority": 3}

        async with pool.lease(service_tier="default") as selected:
            self.assertEqual(selected.account_id, "standard-fast")
        async with pool.lease(service_tier="priority") as selected:
            self.assertEqual(selected.account_id, "priority-fast")

    async def test_tier_latency_measurement_does_not_change_reasoning_or_model(self) -> None:
        pool = NotionAccountPool([FakeClient("one")], account_ids=["one"])
        async with pool.lease(service_tier="ultrafast") as lease:
            await lease.run(lambda _client: asyncio.sleep(0, result="ok"))

        slot = pool._slots[0]
        self.assertEqual(slot.tier_latency_samples["ultrafast"], 1)
        self.assertGreaterEqual(slot.tier_latency_ewma_ms["ultrafast"], 0)

    async def test_reasoning_profiles_route_independently_within_tier(self) -> None:
        pool = NotionAccountPool(
            [FakeClient("low-fast"), FakeClient("xhigh-fast")],
            account_ids=["low-fast", "xhigh-fast"],
        )
        first, second = pool._slots
        first.latency_ewma_ms = second.latency_ewma_ms = 5000
        first.latency_samples = second.latency_samples = 4
        first.tier_latency_ewma_ms = {"priority": 4000}
        second.tier_latency_ewma_ms = {"priority": 4000}
        first.tier_latency_samples = {"priority": 4}
        second.tier_latency_samples = {"priority": 4}
        first.profile_latency_ewma_ms = {
            "priority:low": 1800,
            "priority:xhigh": 9000,
        }
        second.profile_latency_ewma_ms = {
            "priority:low": 8000,
            "priority:xhigh": 2100,
        }
        first.profile_latency_samples = {
            "priority:low": 3,
            "priority:xhigh": 3,
        }
        second.profile_latency_samples = {
            "priority:low": 3,
            "priority:xhigh": 3,
        }

        async with pool.lease(service_tier="priority", reasoning_effort="low") as selected:
            self.assertEqual(selected.account_id, "low-fast")
        async with pool.lease(service_tier="priority", reasoning_effort="xhigh") as selected:
            self.assertEqual(selected.account_id, "xhigh-fast")

    async def test_profile_learning_explores_healthy_accounts_with_old_failures(self) -> None:
        pool = NotionAccountPool(
            [FakeClient("measured"), FakeClient("healthy-unmeasured")],
            account_ids=["measured", "healthy-unmeasured"],
        )
        measured, healthy_unmeasured = pool._slots
        measured.latency_ewma_ms = 2000
        measured.latency_samples = 10
        measured.tier_latency_ewma_ms = {"priority": 2000}
        measured.tier_latency_samples = {"priority": 5}
        measured.profile_latency_ewma_ms = {"priority:low": 1800}
        measured.profile_latency_samples = {"priority:low": 1}

        healthy_unmeasured.latency_ewma_ms = 3500
        healthy_unmeasured.latency_samples = 22
        healthy_unmeasured.tier_latency_ewma_ms = {"priority": 3500}
        healthy_unmeasured.tier_latency_samples = {"priority": 4}
        healthy_unmeasured.successes = 20
        healthy_unmeasured.failures = 2

        async with pool.lease(
            service_tier="priority", reasoning_effort="low"
        ) as selected:
            self.assertEqual(selected.account_id, "healthy-unmeasured")

    async def test_reasoning_profile_measurements_survive_restart(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            state = Path(temporary_directory) / "pool-state.json"
            pool = NotionAccountPool(
                [FakeClient("one")], account_ids=["one"], state_path=state
            )
            async with pool.lease(
                service_tier="priority", reasoning_effort="max"
            ) as lease:
                await lease.run(lambda _client: asyncio.sleep(0, result="ok"))

            restarted = NotionAccountPool(
                [FakeClient("one")], account_ids=["one"], state_path=state
            )
            status = await restarted.status()
            account = status["accounts"][0]
            self.assertEqual(account["profile_latency_samples"]["priority:max"], 1)
            self.assertIsNotNone(
                account["profile_latency_ewma_ms"]["priority:max"]
            )

    async def test_latency_measurements_survive_restart(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            state = Path(temporary_directory) / "pool-state.json"
            pool = NotionAccountPool(
                [FakeClient("one")],
                account_ids=["one"],
                state_path=state,
            )
            async with pool.lease() as lease:
                await lease.run(lambda _client: asyncio.sleep(0, result="ok"))

            restarted = NotionAccountPool(
                [FakeClient("one")],
                account_ids=["one"],
                state_path=state,
            )
            status = await restarted.status()
            self.assertEqual(status["accounts"][0]["latency_samples"], 1)
            self.assertIsNotNone(status["accounts"][0]["latency_ewma_ms"])


class AccountDiscoveryTests(unittest.TestCase):
    @staticmethod
    def write_account(path: Path, token: str, user: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({
            "token_v2": token,
            "user_id": user,
            "space_id": f"space-{user}",
        }), encoding="utf-8")

    def test_builds_ordered_pool_with_isolated_thread_directories(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            home = Path(temporary_directory)
            self.write_account(home / "notion_account.json", "token-main", "user-main")
            self.write_account(home / "accounts" / "b.json", "token-b", "user-b")
            self.write_account(home / "accounts" / "a.json", "token-a", "user-a")

            pool = build_account_pool(home)

            self.assertEqual([
                slot.client.account_path.name for slot in pool._slots
            ], ["notion_account.json", "a.json", "b.json"])
            thread_directories = [slot.client.thread_state_dir for slot in pool._slots]
            self.assertEqual(thread_directories[0], home / "threads")
            self.assertEqual(len(set(thread_directories)), 3)
            self.assertTrue(all(
                path == home / "threads" or path.parent == home / "account-threads"
                for path in thread_directories
            ))

            prep = pool._slots[0].client._prepare_call(
                prompt="test",
                system=None,
                model="gpt-5.6-sol",
                web_search=False,
                workspace_search=False,
                ask_mode=True,
                thread_id=None,
            )
            config = next(
                item["value"]
                for item in prep.body["transcript"]
                if item["type"] == "config"
            )
            self.assertEqual(config["reasoningEffort"], MAX_REASONING_EFFORT)

    def test_excludes_invalid_and_duplicate_sessions(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            home = Path(temporary_directory)
            self.write_account(home / "notion_account.json", "token-main", "same-user")
            self.write_account(home / "accounts" / "duplicate-user.json", "token-new", "same-user")
            (home / "accounts" / "invalid.json").write_text("{}", encoding="utf-8")
            self.write_account(home / "accounts" / "unique.json", "token-unique", "unique-user")

            pool = build_account_pool(home)

            self.assertEqual(pool.size, 2)
            self.assertEqual(pool.discovered_accounts, 4)
            self.assertEqual(pool.duplicate_accounts, 1)
            self.assertEqual(pool.invalid_accounts, 1)

    def test_configures_model_faithful_patch_mode_for_every_account(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            home = Path(temporary_directory)
            self.write_account(home / "notion_account.json", "token-main", "user-main")
            self.write_account(home / "accounts" / "account-02.json", "token-two", "user-two")
            self.write_account(home / "accounts" / "account-03.json", "token-three", "user-three")

            pool = build_account_pool(home)

            modes = {
                slot.client.account_path.name: slot.client.as_patch_response
                for slot in pool._slots
            }
            self.assertEqual(modes, {
                "notion_account.json": True,
                "account-02.json": True,
                "account-03.json": True,
            })

    def test_rejects_more_than_ten_unique_valid_accounts(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            home = Path(temporary_directory)
            for index in range(11):
                self.write_account(
                    home / "accounts" / f"account-{index:02d}.json",
                    f"token-{index}",
                    f"user-{index}",
                )

            with self.assertRaisesRegex(RuntimeError, "at most 10"):
                build_account_pool(home)

    def test_allows_extra_files_when_one_is_a_duplicate(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            home = Path(temporary_directory)
            self.write_account(home / "notion_account.json", "token-0", "user-0")
            for index in range(10):
                self.write_account(
                    home / "accounts" / f"account-{index:02d}.json",
                    f"token-{index}",
                    f"user-{index}",
                )

            self.assertEqual(len(discover_account_paths(home)), 11)
            pool = build_account_pool(home)
            self.assertEqual(pool.size, 10)
            self.assertEqual(pool.duplicate_accounts, 1)


if __name__ == "__main__":
    unittest.main()

class ModelIntegrityFailoverTests(unittest.IsolatedAsyncioTestCase):
    async def test_model_mismatch_fails_over_without_disabling_the_account(self) -> None:
        pool = NotionAccountPool(
            [FakeClient("wrong"), FakeClient("correct")],
            account_ids=["wrong", "correct"],
        )

        async def operation(client: FakeClient) -> str:
            if client.name == "wrong":
                raise account_pool.ModelIntegrityError(
                    "expected orange-mousse, got oval-kumquat-medium",
                    requested_model="gpt-5.6-sol",
                )
            return "orange-mousse"

        async with pool.lease() as lease:
            result = await lease.run(operation)

        self.assertEqual(result, "orange-mousse")
        self.assertFalse(pool._slots[0].disabled)
        self.assertGreater(
            pool._slots[0].model_cooldown_until.get("gpt-5.6-sol", 0), time.time()
        )
        self.assertEqual(pool._slots[1].successes, 1)

    async def test_model_mismatch_quarantines_only_that_model_for_hours(self) -> None:
        wrong = FakeClient("wrong")
        correct = FakeClient("correct")
        pool = NotionAccountPool([wrong, correct], account_ids=["wrong", "correct"])
        attempts: list[str] = []

        async def sol_operation(client: FakeClient) -> str:
            attempts.append(client.name)
            if client.name == "wrong":
                raise account_pool.ModelIntegrityError(
                    "expected orange-mousse, got oval-kumquat-medium",
                    requested_model="gpt-5.6-sol",
                )
            return "orange-mousse"

        async with pool.lease(required_model="gpt-5.6-sol") as lease:
            self.assertEqual(await lease.run(sol_operation), "orange-mousse")

        async with pool.lease(required_model="gpt-5.6-sol") as lease:
            self.assertEqual(await lease.run(sol_operation), "orange-mousse")

        self.assertEqual(attempts, ["wrong", "correct", "correct"])
        self.assertFalse(pool._slots[0].disabled)
        self.assertGreater(
            pool._slots[0].model_cooldown_until["gpt-5.6-sol"],
            time.time() + 3600,
        )

        async with pool.lease(
            required_model="gpt-5.4",
            preferred_account_id="wrong",
        ) as lease:
            self.assertEqual(await lease.run(lambda client: asyncio.sleep(0, result=client.name)), "wrong")


class StaleDisabledAccountRevalidationTests(unittest.IsolatedAsyncioTestCase):
    async def test_successful_sol_probe_restores_persisted_auth_disabled_account(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            state_path = Path(temporary_directory) / "pool-state.json"
            original = NotionAccountPool(
                [RevalidationClient("one", SimpleNamespace(text="OK", model="orange-mousse"))],
                account_ids=["one"],
                state_path=state_path,
            )
            original._slots[0].disabled = True
            original._slots[0].last_error_code = str(ErrorCode.AUTH_INVALID)
            original._save_state()

            client = RevalidationClient("one", SimpleNamespace(text="OK", model="orange-mousse"))
            pool = NotionAccountPool([client], account_ids=["one"], state_path=state_path)

            self.assertEqual(await pool.revalidate_stale_disabled_accounts(), 1)
            self.assertFalse(pool._slots[0].disabled)
            self.assertEqual(pool._slots[0].last_error_code, "")
            self.assertEqual(client.calls[0]["model"], "gpt-5.6-sol")
            async with pool.lease() as lease:
                self.assertEqual(await lease.run(lambda selected: asyncio.sleep(0, result=selected.name)), "one")
            persisted = json.loads(state_path.read_text(encoding="utf-8"))
            self.assertFalse(persisted["accounts"]["one"]["disabled"])

    async def test_failed_or_substituted_probe_keeps_account_disabled(self) -> None:
        for result in (
            RuntimeError("provider denied request"),
            SimpleNamespace(text="OK", model="oval-kumquat-medium"),
        ):
            client = RevalidationClient("one", result)
            pool = NotionAccountPool([client], account_ids=["one"])
            pool._slots[0].disabled = True
            pool._slots[0].last_error_code = str(ErrorCode.PREMIUM_REQUIRED)

            self.assertEqual(await pool.revalidate_stale_disabled_accounts(), 0)
            self.assertTrue(pool._slots[0].disabled)
            self.assertEqual(pool._slots[0].last_error_code, str(ErrorCode.PREMIUM_REQUIRED))

    async def test_legacy_model_integrity_disable_is_restored_on_state_load(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            state_path = Path(temporary_directory) / "pool-state.json"
            state_path.write_text(json.dumps({
                "version": 1,
                "accounts": {
                    "one": {
                        "credential_mtime": 0,
                        "disabled": True,
                        "cooldown_until": 0,
                        "last_error_code": "ModelIntegrityError",
                    },
                },
            }), encoding="utf-8")
            pool = NotionAccountPool([FakeClient("one")], account_ids=["one"], state_path=state_path)

            self.assertFalse(pool._slots[0].disabled)
            persisted = json.loads(state_path.read_text(encoding="utf-8"))
            self.assertFalse(persisted["accounts"]["one"]["disabled"])
