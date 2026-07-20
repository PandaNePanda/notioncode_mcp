from __future__ import annotations

import asyncio
import json
import tempfile
import time
import unittest
from pathlib import Path

from notion_agent_cli.exceptions import ErrorCode, NotionAgentError

from account_pool import (
    MAX_REASONING_EFFORT,
    AccountPoolExhausted,
    NotionAccountPool,
    build_account_pool,
    discover_account_paths,
)


class FakeClient:
    def __init__(self, name: str) -> None:
        self.name = name
        self.closed = False

    async def aclose(self) -> None:
        self.closed = True


class AccountPoolTests(unittest.IsolatedAsyncioTestCase):
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

        with self.assertRaisesRegex(AccountPoolExhausted, "All 2 Notion accounts failed"):
            async with pool.lease() as lease:
                await lease.run(operation)

        self.assertEqual(attempts, ["one", "two"])
        status = await pool.status()
        self.assertEqual(status["busy"], 0)

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
