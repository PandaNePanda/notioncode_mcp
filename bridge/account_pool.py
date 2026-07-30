from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import time
from collections import deque
from collections.abc import Awaitable, Callable
from contextvars import ContextVar
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, TypeVar

import httpx
from notion_agent_cli.exceptions import (
    ErrorCode,
    NotionAgentError,
    retry_policy_for,
)
from notion_agent_cli.provider import NotionAgentClient, fetch_live_client_version

from diagnostics import exception_fields, log_event


MAX_ACCOUNTS = 10
MAX_REASONING_EFFORT = "ultra"
SUPPORTED_REASONING_EFFORTS = frozenset(
    {"none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"}
)
_REQUEST_REASONING_EFFORT: ContextVar[str | None] = ContextVar(
    "notion_request_reasoning_effort",
    default=None,
)
_REQUEST_SERVICE_TIER: ContextVar[str | None] = ContextVar(
    "notion_request_service_tier",
    default=None,
)
INFERENCE_TIMEOUT_SECONDS = max(
    1.0,
    float(os.getenv("NOTION_INFERENCE_TIMEOUT_SECONDS", "180")),
)
# Keep one short retry inside the bridge for ordinary transient failures.
# A 180-second recovery window made a one-account setup wait in repeated
# 30-second cooldowns, so even a trivial prompt could take several minutes.
POOL_RECOVERY_WAIT_SECONDS = max(
    1.0,
    float(os.getenv("NOTION_POOL_RECOVERY_WAIT_SECONDS", "8")),
)
MAX_RECOVERY_CYCLES = max(
    0,
    int(os.getenv("NOTION_MAX_RECOVERY_CYCLES", "1")),
)
SINGLE_ACCOUNT_TRANSIENT_COOLDOWN = max(
    0.1,
    float(os.getenv("NOTION_SINGLE_ACCOUNT_TRANSIENT_COOLDOWN_SECONDS", "1")),
)
DEFAULT_TRANSIENT_COOLDOWN = 30
DEFAULT_DENIAL_COOLDOWN = 300
EMPTY_TEXT_COOLDOWN = 60
# A provider-side model substitution is not an account credential failure. Keep
# the affected model unavailable long enough to prevent every new request from
# repeating the same slow, doomed failover, while preserving every other
# advertised model (for example, Terra after a Sol mismatch).
MODEL_INTEGRITY_COOLDOWN = max(
    1.0,
    float(os.getenv("NOTION_MODEL_INTEGRITY_COOLDOWN_SECONDS", "21600")),
)
# The upstream library's generic retry advice is 30 seconds. That is too long
# for a multi-account interactive pool: one short retryable error on each slot
# leaves every account cooling down and turns later requests into avoidable
# 503s. Live Sol probes showed the same accounts succeeding again within a few
# seconds. Keep hard denials and EMPTY_TEXT quarantine unchanged, but allow
# ordinary retryable transport/HTTP/Notion errors to fail over and recover
# inside the bridge's bounded recovery window.
TRANSIENT_FAILOVER_COOLDOWN = max(
    0.1,
    float(os.getenv("NOTION_TRANSIENT_FAILOVER_COOLDOWN_SECONDS", "2")),
)
# Accounts that repeatedly pass credential validation but fail real inference
# are worse than having fewer accounts: they add a failed attempt to nearly
# every request and can push the whole pool into a visible 503/cooldown loop.
# Quarantine those accounts for several hours, while allowing an updated
# credential file to clear the quarantine on restart.
UNHEALTHY_ACCOUNT_MIN_OUTCOMES = 10
UNHEALTHY_ACCOUNT_FAILURE_RATIO = 0.60
UNHEALTHY_ACCOUNT_COOLDOWN = 6 * 60 * 60
GLOBAL_FAILURE_WINDOW = 30
GLOBAL_FAILURE_THRESHOLD = 3
CLIENT_VERSION_REFRESH_SECONDS = max(
    300.0,
    float(os.getenv("NOTION_CLIENT_VERSION_REFRESH_SECONDS", "21600")),
)
log = logging.getLogger("uvicorn.error.notion_pool")

_LOCAL_ERROR_CODES = {
    ErrorCode.EMPTY_PROMPT,
    ErrorCode.INVALID_CALLBACK,
    ErrorCode.ACCOUNT_MISSING,
    ErrorCode.ACCOUNT_MALFORMED,
    ErrorCode.ACCOUNT_INVALID,
    ErrorCode.WORKSPACE_AMBIGUOUS,
    ErrorCode.WORKSPACE_EMPTY,
    ErrorCode.THREAD_STATE_MISSING,
    ErrorCode.THREAD_STATE_MALFORMED,
}

T = TypeVar("T")


def normalize_reasoning_effort(value: Any) -> str:
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in SUPPORTED_REASONING_EFFORTS:
            return normalized
    return MAX_REASONING_EFFORT


def normalize_service_tier(value: Any) -> str:
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"priority", "fast"}:
            return "priority"
        if normalized == "ultrafast":
            return "ultrafast"
    return "default"


def latency_profile_key(service_tier: Any, reasoning_effort: Any) -> str:
    return (
        f"{normalize_service_tier(service_tier)}:"
        f"{normalize_reasoning_effort(reasoning_effort)}"
    )


class MaxEffortNotionAgentClient(NotionAgentClient):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._client_version_checked_at = 0.0

    async def _refresh_client_version_if_needed(self) -> None:
        now = time.monotonic()
        if (
            self._client_version_checked_at > 0
            and now - self._client_version_checked_at < CLIENT_VERSION_REFRESH_SECONDS
        ):
            return
        self._client_version_checked_at = now
        try:
            live_version = await fetch_live_client_version()
        except Exception as error:
            log_event(
                log,
                "client_version_refresh_failed",
                level=logging.WARNING,
                **exception_fields(error),
            )
            return
        account = self.load_account()
        if account.client_version == live_version:
            return
        previous_version = account.client_version
        self._account = replace(account, client_version=live_version)
        log_event(
            log,
            "client_version_refreshed",
            previous_version=previous_version,
            live_version=live_version,
        )

    async def complete(self, *args: Any, **kwargs: Any):
        reasoning_effort = kwargs.pop("reasoning_effort", None)
        service_tier = kwargs.pop("service_tier", None)
        request_effort = (
            normalize_reasoning_effort(reasoning_effort)
            if reasoning_effort is not None
            else None
        )
        token = _REQUEST_REASONING_EFFORT.set(
            request_effort
        )
        tier_token = _REQUEST_SERVICE_TIER.set(
            service_tier.strip().lower()
            if isinstance(service_tier, str) and service_tier.strip()
            else None
        )
        await self._refresh_client_version_if_needed()
        try:
            # Never retry in legacy cumulative mode. Live probes proved that
            # legacy mode can reject or substitute an explicitly selected
            # model, including gpt-5.6-sol. Propagate EMPTY_TEXT so the account
            # pool can fail over to another patch-mode account without silently
            # changing model, reasoning effort, or service tier.
            return await super().complete(*args, **kwargs)
        finally:
            _REQUEST_REASONING_EFFORT.reset(token)
            _REQUEST_SERVICE_TIER.reset(tier_token)

    def _prepare_call(self, *args: Any, **kwargs: Any):
        explicit_effort = kwargs.pop("reasoning_effort", None)
        explicit_service_tier = kwargs.pop("service_tier", None)
        prep = super()._prepare_call(*args, **kwargs)
        reasoning_effort = normalize_reasoning_effort(
            explicit_effort
            if explicit_effort is not None
            else _REQUEST_REASONING_EFFORT.get()
        )
        transcript = prep.body.get("transcript")
        if not isinstance(transcript, list):
            raise RuntimeError("Notion inference request has no transcript")
        for item in transcript:
            if not isinstance(item, dict) or item.get("type") != "config":
                continue
            config = item.get("value")
            if not isinstance(config, dict):
                raise RuntimeError("Notion inference request has no config value")
            config["reasoningEffort"] = reasoning_effort
            service_tier = (
                explicit_service_tier
                if explicit_service_tier is not None
                else _REQUEST_SERVICE_TIER.get()
            )
            if isinstance(service_tier, str) and service_tier.strip():
                # Best-effort provider config field. Older Notion backends may
                # ignore it, but preserving it lets compatible providers use
                # Fast/Ultrafast without changing the selected base model.
                config["serviceTier"] = service_tier.strip().lower()
            return prep
        raise RuntimeError("Notion inference request has no config block")


class AccountPoolExhausted(RuntimeError):
    """Every configured Notion account failed for one operation."""


class ModelIntegrityError(RuntimeError):
    """The provider returned a model other than the explicitly selected one."""

    def __init__(self, message: str, *, requested_model: str | None = None) -> None:
        super().__init__(message)
        self.requested_model = requested_model


class AccountPoolCoolingDown(AccountPoolExhausted):
    def __init__(self, retry_after: int) -> None:
        super().__init__(f"All Notion accounts are cooling down; retry after {retry_after}s")
        self.retry_after = retry_after


@dataclass(slots=True)
class _AccountSlot:
    number: int
    client: NotionAgentClient
    account_id: str = ""
    credential_mtime: float = 0
    busy: bool = False
    disabled: bool = False
    cooldown_until: float = 0
    last_assigned_at: float = 0
    assignments: int = 0
    successes: int = 0
    failures: int = 0
    last_error_code: str = ""
    latency_ewma_ms: float = 0
    latency_samples: int = 0
    tier_latency_ewma_ms: dict[str, float] = field(default_factory=dict)
    tier_latency_samples: dict[str, int] = field(default_factory=dict)
    profile_latency_ewma_ms: dict[str, float] = field(default_factory=dict)
    profile_latency_samples: dict[str, int] = field(default_factory=dict)
    model_cooldown_until: dict[str, float] = field(default_factory=dict)


def is_failover_error(error: Exception) -> bool:
    if isinstance(error, ModelIntegrityError):
        return True
    if isinstance(error, httpx.HTTPError):
        return True
    if isinstance(error, NotionAgentError):
        return error.code not in _LOCAL_ERROR_CODES
    return False


def discover_account_paths(account_home: Path) -> list[Path]:
    legacy = account_home / "notion_account.json"
    accounts_dir = account_home / "accounts"
    paths = [legacy] if legacy.is_file() else []
    if accounts_dir.is_dir():
        paths.extend(sorted(path for path in accounts_dir.glob("*.json") if path.is_file()))
    return paths


def build_account_pool(account_home: Path) -> NotionAccountPool:
    account_paths = discover_account_paths(account_home)
    clients: list[NotionAgentClient] = []
    invalid_accounts = 0
    duplicate_accounts = 0
    token_fingerprints: set[str] = set()
    user_fingerprints: set[str] = set()
    invalid_details: list[dict[str, str]] = []

    for account_path in account_paths:
        if account_path == account_home / "notion_account.json":
            thread_state_dir = account_home / "threads"
        else:
            path_key = hashlib.sha256(str(account_path.resolve()).encode()).hexdigest()[:16]
            thread_state_dir = account_home / "account-threads" / path_key
        client = MaxEffortNotionAgentClient(
            account_path,
            thread_state_dir=thread_state_dir,
            # Patch responses preserve the explicitly selected Notion model.
            # Live cross-account probes proved that legacy cumulative mode
            # rejects or substitutes gpt-5.6-sol, while patch mode executes its
            # resolved orange-mousse model correctly on every configured
            # account. Never choose response mode by account filename or speed.
            as_patch_response=True,
        )
        try:
            account = client.load_account()
            if not isinstance(account.token_v2, str) or not account.token_v2.strip():
                raise ValueError("token_v2 must be a non-empty string")
            if not isinstance(account.user_id, str) or not account.user_id.strip():
                raise ValueError("user_id must be a non-empty string")
            fingerprint = hashlib.sha256(account.token_v2.encode()).hexdigest()
            user_fingerprint = hashlib.sha256(account.user_id.encode()).hexdigest()
        except (NotionAgentError, OSError, TypeError, ValueError, AttributeError) as error:
            invalid_accounts += 1
            invalid_details.append({
                "file": account_path.name,
                "reason": error.code if isinstance(error, NotionAgentError) else type(error).__name__,
            })
            continue
        if fingerprint in token_fingerprints or user_fingerprint in user_fingerprints:
            duplicate_accounts += 1
            continue
        if len(clients) >= MAX_ACCOUNTS:
            raise RuntimeError(
                f"Found more than {MAX_ACCOUNTS} unique valid Notion accounts; "
                f"at most {MAX_ACCOUNTS} are supported"
            )
        token_fingerprints.add(fingerprint)
        user_fingerprints.add(user_fingerprint)
        clients.append(client)

    return NotionAccountPool(
        clients,
        account_ids=[hashlib.sha256(client.load_account().token_v2.encode()).hexdigest()[:16] for client in clients],
        state_path=account_home / "pool-state.json",
        discovered_accounts=len(account_paths),
        invalid_accounts=invalid_accounts,
        duplicate_accounts=duplicate_accounts,
        invalid_details=invalid_details,
    )


class NotionAccountPool:
    def __init__(
        self,
        clients: list[NotionAgentClient],
        *,
        account_ids: list[str] | None = None,
        state_path: Path | None = None,
        discovered_accounts: int | None = None,
        invalid_accounts: int = 0,
        duplicate_accounts: int = 0,
        invalid_details: list[dict[str, str]] | None = None,
    ) -> None:
        if len(clients) > MAX_ACCOUNTS:
            raise ValueError(f"At most {MAX_ACCOUNTS} Notion clients are supported")
        ids = account_ids or [f"account-{index + 1:02d}" for index in range(len(clients))]
        if len(ids) != len(clients):
            raise ValueError("account_ids must match the number of clients")
        self._slots = [
            _AccountSlot(
                number=index + 1,
                client=client,
                account_id=ids[index],
                credential_mtime=(
                    client.account_path.stat().st_mtime
                    if getattr(client, "account_path", None) and client.account_path.exists()
                    else 0
                ),
            )
            for index, client in enumerate(clients)
        ]
        self._condition = asyncio.Condition()
        self._state_path = state_path
        self._global_cooldown_until = 0.0
        self._recent_failures: deque[tuple[float, str, str]] = deque()
        self.discovered_accounts = (
            len(clients) if discovered_accounts is None else discovered_accounts
        )
        self.invalid_accounts = invalid_accounts
        self.duplicate_accounts = duplicate_accounts
        self.invalid_details = invalid_details or []
        self._load_state()

    @property
    def size(self) -> int:
        return len(self._slots)

    @property
    def clients(self) -> tuple[NotionAgentClient, ...]:
        """Return configured clients without exposing account contents."""
        return tuple(slot.client for slot in self._slots)

    async def eligible_clients(self) -> tuple[NotionAgentClient, ...]:
        """Return clients eligible to attest the currently available model catalog."""
        async with self._condition:
            return tuple(slot.client for slot in self._slots if not slot.disabled)

    def lease(
        self,
        preferred_account_id: str | None = None,
        avoid_account_id: str | None = None,
        service_tier: str | None = None,
        reasoning_effort: str | None = None,
        required_model: str | None = None,
    ) -> AccountLease:
        return AccountLease(
            self,
            preferred_account_id=preferred_account_id,
            avoid_account_id=avoid_account_id,
            service_tier=normalize_service_tier(service_tier),
            reasoning_effort=normalize_reasoning_effort(reasoning_effort),
            required_model=required_model,
        )

    async def status(self) -> dict[str, Any]:
        async with self._condition:
            now = time.time()
            return {
                "configured": self.size,
                "busy": sum(slot.busy for slot in self._slots),
                "available": sum(
                    not slot.busy and not slot.disabled and slot.cooldown_until <= now
                    for slot in self._slots
                ),
                "cooldown": sum(
                    not slot.disabled and slot.cooldown_until > now for slot in self._slots
                ),
                "disabled": sum(slot.disabled for slot in self._slots),
                "discovered": self.discovered_accounts,
                "invalid": self.invalid_accounts,
                "invalid_accounts": self.invalid_details,
                "duplicates": self.duplicate_accounts,
                "maximum": MAX_ACCOUNTS,
                "global_retry_after": max(0, round(self._global_cooldown_until - now)),
                "accounts": [
                    {
                        "id": slot.account_id,
                        "file": (
                            getattr(slot.client, "account_path", None).name
                            if getattr(slot.client, "account_path", None) else "memory"
                        ),
                        "state": (
                            "disabled" if slot.disabled else
                            "busy" if slot.busy else
                            "cooldown" if slot.cooldown_until > now else
                            "ready"
                        ),
                        "retry_after": max(0, round(slot.cooldown_until - now)),
                        "assignments": slot.assignments,
                        "successes": slot.successes,
                        "failures": slot.failures,
                        "last_error": slot.last_error_code or None,
                        "latency_ewma_ms": round(slot.latency_ewma_ms) if slot.latency_samples else None,
                        "latency_samples": slot.latency_samples,
                        "tier_latency_ewma_ms": {
                            tier: round(value)
                            for tier, value in slot.tier_latency_ewma_ms.items()
                        },
                        "tier_latency_samples": dict(slot.tier_latency_samples),
                        "profile_latency_ewma_ms": {
                            profile: round(value)
                            for profile, value in slot.profile_latency_ewma_ms.items()
                        },
                        "profile_latency_samples": dict(slot.profile_latency_samples),
                    }
                    for slot in self._slots
                ],
            }

    async def aclose(self) -> None:
        await asyncio.gather(
            *(slot.client.aclose() for slot in self._slots),
            return_exceptions=True,
        )

    async def revalidate_stale_disabled_accounts(self) -> int:
        """Restore only accounts disabled by a stale auth or entitlement result.

        Model-integrity failures remain disabled until the credential file changes,
        because accepting a substituted model would violate the selected model.
        """
        async with self._condition:
            candidates = [
                slot for slot in self._slots
                if slot.disabled
                and slot.last_error_code in {
                    str(ErrorCode.AUTH_INVALID),
                    str(ErrorCode.PREMIUM_REQUIRED),
                }
            ]
        restored = 0
        for slot in candidates:
            try:
                result = await asyncio.wait_for(
                    slot.client.complete(
                        prompt="Reply with exactly OK.",
                        model="gpt-5.6-sol",
                        web_search=False,
                        workspace_search=False,
                        ask_mode=True,
                        reasoning_effort="low",
                    ),
                    timeout=INFERENCE_TIMEOUT_SECONDS,
                )
                if not isinstance(getattr(result, "text", None), str) or not result.text.strip():
                    raise RuntimeError("empty validation response")
                raw = getattr(result, "raw", None)
                reported = raw.get("reported_notion_model") if isinstance(raw, dict) else None
                actual_model = getattr(result, "model", None) or reported
                if actual_model != "orange-mousse":
                    raise ModelIntegrityError(
                        "stale-account validation requested gpt-5.6-sol but received "
                        f"{actual_model!r}"
                    )
            except Exception as error:
                log_event(
                    log,
                    "account_revalidation_failed",
                    level=logging.WARNING,
                    account_number=slot.number,
                    account_id=slot.account_id,
                    account_file=self._account_file(slot),
                    **exception_fields(error),
                )
                continue
            async with self._condition:
                slot.disabled = False
                slot.cooldown_until = 0
                slot.last_error_code = ""
                self._save_state()
                self._condition.notify_all()
            restored += 1
            log_event(
                log,
                "account_revalidated",
                account_number=slot.number,
                account_id=slot.account_id,
                account_file=self._account_file(slot),
            )
        return restored

    def _load_state(self) -> None:
        if self._state_path is None or not self._state_path.is_file():
            return
        try:
            state = json.loads(self._state_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError, TypeError):
            log.warning("Ignoring malformed account pool state at %s", self._state_path)
            return
        saved_accounts = state.get("accounts", {}) if isinstance(state, dict) else {}
        if not isinstance(saved_accounts, dict):
            return
        migrated_legacy_model_integrity = False
        for slot in self._slots:
            saved = saved_accounts.get(slot.account_id)
            if not isinstance(saved, dict):
                continue
            slot.last_assigned_at = float(saved.get("last_assigned_at", 0) or 0)
            slot.assignments = int(saved.get("assignments", 0) or 0)
            slot.successes = int(saved.get("successes", 0) or 0)
            slot.failures = int(saved.get("failures", 0) or 0)
            slot.latency_ewma_ms = float(saved.get("latency_ewma_ms", 0) or 0)
            slot.latency_samples = int(saved.get("latency_samples", 0) or 0)
            saved_tier_ewma = saved.get("tier_latency_ewma_ms", {})
            saved_tier_samples = saved.get("tier_latency_samples", {})
            saved_profile_ewma = saved.get("profile_latency_ewma_ms", {})
            saved_profile_samples = saved.get("profile_latency_samples", {})
            if isinstance(saved_tier_ewma, dict):
                slot.tier_latency_ewma_ms = {
                    normalize_service_tier(tier): float(value)
                    for tier, value in saved_tier_ewma.items()
                    if isinstance(tier, str) and isinstance(value, (int, float))
                }
            if isinstance(saved_tier_samples, dict):
                slot.tier_latency_samples = {
                    normalize_service_tier(tier): int(value)
                    for tier, value in saved_tier_samples.items()
                    if isinstance(tier, str) and isinstance(value, (int, float))
                }
            if isinstance(saved_profile_ewma, dict):
                slot.profile_latency_ewma_ms = {
                    profile: float(value)
                    for profile, value in saved_profile_ewma.items()
                    if isinstance(profile, str)
                    and ":" in profile
                    and isinstance(value, (int, float))
                }
            if isinstance(saved_profile_samples, dict):
                slot.profile_latency_samples = {
                    profile: int(value)
                    for profile, value in saved_profile_samples.items()
                    if isinstance(profile, str)
                    and ":" in profile
                    and isinstance(value, (int, float))
                }
            credential_unchanged = float(saved.get("credential_mtime", 0) or 0) == slot.credential_mtime
            if credential_unchanged:
                slot.cooldown_until = float(saved.get("cooldown_until", 0) or 0)
                slot.disabled = bool(saved.get("disabled", False))
                saved_model_cooldowns = saved.get("model_cooldown_until", {})
                if isinstance(saved_model_cooldowns, dict):
                    slot.model_cooldown_until = {
                        model: float(until)
                        for model, until in saved_model_cooldowns.items()
                        if isinstance(model, str) and isinstance(until, (int, float))
                    }
            slot.last_error_code = str(saved.get("last_error_code", "") or "")
            # Versions before model-scoped cooldowns persisted a model mismatch as
            # a disabled account. That state is safe to undo: token/auth failures
            # retain their disabled state and still require explicit validation.
            if slot.disabled and slot.last_error_code.startswith("ModelIntegrityError"):
                slot.disabled = False
                slot.cooldown_until = 0
                slot.last_error_code = ""
                migrated_legacy_model_integrity = True
        if migrated_legacy_model_integrity:
            self._save_state()

    def _save_state(self) -> None:
        if self._state_path is None:
            return
        state = {
            "version": 1,
            "accounts": {
                slot.account_id: {
                    "last_assigned_at": slot.last_assigned_at,
                    "assignments": slot.assignments,
                    "successes": slot.successes,
                    "failures": slot.failures,
                    "cooldown_until": slot.cooldown_until,
                    "disabled": slot.disabled,
                    "last_error_code": slot.last_error_code,
                    "latency_ewma_ms": slot.latency_ewma_ms,
                    "latency_samples": slot.latency_samples,
                    "tier_latency_ewma_ms": slot.tier_latency_ewma_ms,
                    "tier_latency_samples": slot.tier_latency_samples,
                    "profile_latency_ewma_ms": slot.profile_latency_ewma_ms,
                    "profile_latency_samples": slot.profile_latency_samples,
                    "model_cooldown_until": slot.model_cooldown_until,
                    "credential_mtime": slot.credential_mtime,
                }
                for slot in self._slots
            },
        }
        temporary = self._state_path.with_suffix(".tmp")
        try:
            self._state_path.parent.mkdir(parents=True, exist_ok=True)
            with temporary.open("w", encoding="utf-8") as handle:
                json.dump(state, handle, indent=2)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            if os.name != "nt":
                temporary.chmod(0o600)
            os.replace(temporary, self._state_path)
        except OSError as error:
            log.warning("Could not persist account scheduler state: %s", error)

    async def _acquire(
        self,
        excluded: set[int],
        preferred_account_id: str | None = None,
        avoid_account_id: str | None = None,
        recovery_deadline: float | None = None,
        service_tier: str = "default",
        reasoning_effort: str = MAX_REASONING_EFFORT,
        required_model: str | None = None,
    ) -> _AccountSlot:
        if not self._slots:
            raise AccountPoolExhausted("No valid Notion accounts are configured")
        if len(excluded) >= len(self._slots):
            raise AccountPoolExhausted("All configured Notion accounts have failed")

        async with self._condition:
            while True:
                now = time.time()
                ready_failover_accounts = [
                    slot for index, slot in enumerate(self._slots)
                    if index not in excluded
                    and not slot.busy
                    and not slot.disabled
                    and slot.cooldown_until <= now
                    and self._model_is_ready(slot, required_model, now)
                    and self._advertises_model(slot, required_model)
                ]
                # The global breaker protects a new request when recent failures
                # indicate a provider-wide outage. It must not pause an in-flight
                # request before trying a distinct account that is already ready.
                # Previously, historical failures from three accounts caused each
                # ordinary failover to sleep for two seconds and could exhaust the
                # whole recovery budget before the final healthy account ran.
                bypass_global_cooldown = bool(excluded and ready_failover_accounts)
                if self._global_cooldown_until > now and not bypass_global_cooldown:
                    retry_after = max(1, round(self._global_cooldown_until - now))
                    remaining = (
                        recovery_deadline - time.monotonic()
                        if recovery_deadline is not None else 0
                    )
                    if remaining > 0:
                        wait_seconds = min(
                            self._global_cooldown_until - now,
                            remaining,
                        )
                        log_event(
                            log,
                            "account_pool_recovery_wait",
                            level=logging.WARNING,
                            reason="global_cooldown",
                            wait_seconds=round(wait_seconds, 3),
                        )
                        try:
                            await asyncio.wait_for(
                                self._condition.wait(),
                                timeout=max(0.001, wait_seconds),
                            )
                        except asyncio.TimeoutError:
                            pass
                        continue
                    log_event(
                        log,
                        "circuit_breaker_active",
                        level=logging.WARNING,
                        retry_after=retry_after,
                    )
                    raise AccountPoolCoolingDown(retry_after)
                eligible = ready_failover_accounts
                selected = next(
                    (slot for slot in eligible if slot.account_id == preferred_account_id),
                    None,
                )
                selection_pool = eligible
                if selected is None and avoid_account_id is not None:
                    alternatives = [
                        slot for slot in eligible
                        if slot.account_id != avoid_account_id
                    ]
                    if alternatives:
                        selection_pool = alternatives
                if selected is None and selection_pool:
                    # Explore every account once, then route new conversations to
                    # the account with the lowest measured end-to-end latency.
                    # Existing conversations still use preferred_account_id so
                    # Notion thread continuity is never sacrificed for speed.
                    # Only explore accounts that have never produced either a
                    # success or a failure. An account returning empty output
                    # must not remain "unmeasured" forever and win every new
                    # selection merely because it has no successful latency.
                    # Provider scheduling can differ substantially by tier. A
                    # single all-tier EWMA allowed slow Priority requests to be
                    # routed using Standard measurements (and vice versa).
                    # Explore each healthy account once per tier, then use that
                    # tier's measured latency. The selected model and reasoning
                    # effort are untouched.
                    tier = normalize_service_tier(service_tier)
                    effort = normalize_reasoning_effort(reasoning_effort)
                    profile = latency_profile_key(tier, effort)
                    # A newly introduced tier+effort profile has no historical
                    # samples after migration. Bootstrap its first selection
                    # from the existing tier/overall latency data instead of
                    # treating every account as equally unmeasured. Once one
                    # account has produced a profile sample, explore the other
                    # healthy accounts once for that profile before preferring
                    # the lowest profile EWMA.
                    profile_learning_started = any(
                        slot.profile_latency_samples.get(profile, 0) > 0
                        for slot in selection_pool
                    )
                    unmeasured = [
                        slot for slot in selection_pool
                        if profile_learning_started
                        and slot.profile_latency_samples.get(profile, 0) == 0
                        and not (
                            slot.successes + slot.failures >= UNHEALTHY_ACCOUNT_MIN_OUTCOMES
                            and slot.failures / max(1, slot.successes + slot.failures)
                            >= UNHEALTHY_ACCOUNT_FAILURE_RATIO
                        )
                    ]
                    if unmeasured:
                        selected = min(
                            unmeasured,
                            key=lambda slot: (slot.last_assigned_at, slot.assignments, slot.number),
                        )
                    else:
                        selected = min(
                            selection_pool,
                            key=lambda slot: (
                                # Quarantine-grade reliability problems must
                                # beat raw speed, but small historical failure
                                # differences between healthy accounts must not
                                # route every new turn to a much slower account.
                                # The previous ordering put failure ratio first,
                                # so an account with 0 failures and 17 s latency
                                # beat a healthy account averaging 8 s forever.
                                (
                                    slot.successes + slot.failures >= UNHEALTHY_ACCOUNT_MIN_OUTCOMES
                                    and slot.failures / max(1, slot.successes + slot.failures)
                                    >= UNHEALTHY_ACCOUNT_FAILURE_RATIO
                                ),
                                (
                                    slot.profile_latency_ewma_ms.get(profile, 0)
                                    or slot.tier_latency_ewma_ms.get(tier, 0)
                                    or (
                                        slot.latency_ewma_ms
                                        if slot.latency_samples else float("inf")
                                    )
                                ),
                                slot.failures / max(1, slot.successes + slot.failures),
                                slot.last_assigned_at,
                                slot.assignments,
                                slot.number,
                            ),
                        )
                if selected is not None:
                    selected.busy = True
                    selected.last_assigned_at = now
                    selected.assignments += 1
                    self._save_state()
                    selection = "affinity" if selected.account_id == preferred_account_id else (
                        "failover" if excluded else
                        "tier_latency" if selected.tier_latency_samples.get(
                            normalize_service_tier(service_tier), 0
                        ) else
                        "latency" if selected.latency_samples else
                        "balanced"
                    )
                    log_event(
                        log,
                        "account_selected",
                        account_number=selected.number,
                        account_id=selected.account_id,
                        account_file=self._account_file(selected),
                        selection=selection,
                        avoided_account_id=avoid_account_id,
                        attempt=len(excluded) + 1,
                        assignments=selected.assignments,
                        latency_ewma_ms=(
                            round(selected.latency_ewma_ms)
                            if selected.latency_samples else None
                        ),
                        service_tier=normalize_service_tier(service_tier),
                        reasoning_effort=normalize_reasoning_effort(reasoning_effort),
                        required_model=required_model,
                        tier_latency_ewma_ms=(
                            round(selected.tier_latency_ewma_ms[
                                normalize_service_tier(service_tier)
                            ])
                            if selected.tier_latency_samples.get(
                                normalize_service_tier(service_tier), 0
                            ) else None
                        ),
                        profile_latency_ewma_ms=(
                            round(selected.profile_latency_ewma_ms[
                                latency_profile_key(service_tier, reasoning_effort)
                            ])
                            if selected.profile_latency_samples.get(
                                latency_profile_key(service_tier, reasoning_effort), 0
                            ) else None
                        ),
                    )
                    return selected
                waiting_busy = any(
                    index not in excluded
                    and slot.busy
                    and not slot.disabled
                    and self._model_is_ready(slot, required_model, now)
                    and self._advertises_model(slot, required_model)
                    for index, slot in enumerate(self._slots)
                )
                if waiting_busy:
                    await self._condition.wait()
                    continue
                retry_times = [
                    max(slot.cooldown_until, self._model_cooldown_until(slot, required_model))
                    for index, slot in enumerate(self._slots)
                    if index not in excluded
                    and not slot.disabled
                    and self._advertises_model(slot, required_model)
                    and max(slot.cooldown_until, self._model_cooldown_until(slot, required_model)) > now
                ]
                if retry_times:
                    retry_after = max(1, round(min(retry_times) - now))
                    remaining = (
                        recovery_deadline - time.monotonic()
                        if recovery_deadline is not None else 0
                    )
                    if remaining > 0:
                        wait_seconds = min(min(retry_times) - now, remaining)
                        log_event(
                            log,
                            "account_pool_recovery_wait",
                            level=logging.WARNING,
                            reason="account_cooldown",
                            wait_seconds=round(wait_seconds, 3),
                        )
                        try:
                            await asyncio.wait_for(
                                self._condition.wait(),
                                timeout=max(0.001, wait_seconds),
                            )
                        except asyncio.TimeoutError:
                            pass
                        continue
                    log_event(
                        log,
                        "account_pool_cooling_down",
                        level=logging.WARNING,
                        retry_after=retry_after,
                    )
                    raise AccountPoolCoolingDown(retry_after)
                log_event(log, "account_pool_exhausted", level=logging.ERROR)
                raise AccountPoolExhausted("No usable Notion accounts are available")

    @staticmethod
    def _advertises_model(slot: _AccountSlot, required_model: str | None) -> bool:
        if not required_model:
            return True
        advertised = getattr(slot.client, "_notion_available_model_aliases", None)
        # Before the first successful catalog refresh, retain the old behavior
        # rather than making the whole bridge unavailable. Once discovery has
        # run, route only to accounts that advertised the selected alias.
        return advertised is None or required_model in advertised

    @staticmethod
    def _model_cooldown_until(slot: _AccountSlot, required_model: str | None) -> float:
        return slot.model_cooldown_until.get(required_model, 0) if required_model else 0

    @classmethod
    def _model_is_ready(cls, slot: _AccountSlot, required_model: str | None, now: float) -> bool:
        return cls._model_cooldown_until(slot, required_model) <= now

    @classmethod
    def _supports_model(cls, slot: _AccountSlot, required_model: str | None) -> bool:
        return cls._advertises_model(slot, required_model) and cls._model_is_ready(
            slot, required_model, time.time()
        )

    @staticmethod
    def _account_file(slot: _AccountSlot) -> str:
        account_path = getattr(slot.client, "account_path", None)
        return account_path.name if account_path is not None else "memory"

    async def _release(self, slot: _AccountSlot) -> None:
        async with self._condition:
            slot.busy = False
            self._condition.notify_all()

    async def _record_success(
        self,
        slot: _AccountSlot,
        duration_ms: int,
        service_tier: str = "default",
        reasoning_effort: str = MAX_REASONING_EFFORT,
        required_model: str | None = None,
    ) -> None:
        async with self._condition:
            slot.successes += 1
            slot.last_error_code = ""
            if required_model:
                slot.model_cooldown_until.pop(required_model, None)
            # EWMA reacts to sustained speed differences without allowing one
            # unusually slow or fast request to permanently bias routing.
            if slot.latency_samples == 0:
                slot.latency_ewma_ms = float(duration_ms)
            else:
                slot.latency_ewma_ms = (
                    0.25 * duration_ms + 0.75 * slot.latency_ewma_ms
                )
            slot.latency_samples += 1
            tier = normalize_service_tier(service_tier)
            tier_samples = slot.tier_latency_samples.get(tier, 0)
            if tier_samples == 0:
                slot.tier_latency_ewma_ms[tier] = float(duration_ms)
            else:
                slot.tier_latency_ewma_ms[tier] = (
                    0.25 * duration_ms
                    + 0.75 * slot.tier_latency_ewma_ms[tier]
                )
            slot.tier_latency_samples[tier] = tier_samples + 1
            effort = normalize_reasoning_effort(reasoning_effort)
            profile = latency_profile_key(tier, effort)
            profile_samples = slot.profile_latency_samples.get(profile, 0)
            if profile_samples == 0:
                slot.profile_latency_ewma_ms[profile] = float(duration_ms)
            else:
                slot.profile_latency_ewma_ms[profile] = (
                    0.25 * duration_ms
                    + 0.75 * slot.profile_latency_ewma_ms[profile]
                )
            slot.profile_latency_samples[profile] = profile_samples + 1
            self._save_state()
            log_event(
                log,
                "account_request_succeeded",
                account_number=slot.number,
                account_id=slot.account_id,
                account_file=self._account_file(slot),
                duration_ms=duration_ms,
                latency_ewma_ms=round(slot.latency_ewma_ms),
                latency_samples=slot.latency_samples,
                service_tier=tier,
                reasoning_effort=effort,
                tier_latency_ewma_ms=round(slot.tier_latency_ewma_ms[tier]),
                tier_latency_samples=slot.tier_latency_samples[tier],
                profile_latency_ewma_ms=round(slot.profile_latency_ewma_ms[profile]),
                profile_latency_samples=slot.profile_latency_samples[profile],
                successes=slot.successes,
            )

    async def _record_failure(
        self,
        slot: _AccountSlot,
        error: Exception,
        duration_ms: int,
        required_model: str | None = None,
    ) -> None:
        now = time.time()
        code = error.code if isinstance(error, NotionAgentError) else type(error).__name__
        retryable: bool | None = None
        retry_after: int | None = None
        subtype = ""
        if isinstance(error, NotionAgentError):
            retryable, retry_after = retry_policy_for(error.code)
            if error.retryable is not None:
                retryable = error.retryable
                if error.retryable is False:
                    retry_after = DEFAULT_DENIAL_COOLDOWN
            subtype = error.subtype or ""
        if isinstance(error, httpx.HTTPError):
            retryable, retry_after = True, DEFAULT_TRANSIENT_COOLDOWN
        if retryable is True and code in {
            ErrorCode.TRANSPORT,
            ErrorCode.HTTP_ERROR,
            ErrorCode.NOTION_ERROR,
            "ConnectError",
            "ReadError",
            "WriteError",
            "PoolTimeout",
        }:
            retry_after = min(
                retry_after if retry_after is not None else DEFAULT_TRANSIENT_COOLDOWN,
                TRANSIENT_FAILOVER_COOLDOWN,
            )
        async with self._condition:
            slot.failures += 1
            slot.last_error_code = f"{code}:{subtype}" if subtype else str(code)
            outcomes = slot.successes + slot.failures
            failure_ratio = slot.failures / max(1, outcomes)
            health_quarantined = (
                code in {ErrorCode.EMPTY_TEXT, ErrorCode.NOTION_ERROR}
                and outcomes >= UNHEALTHY_ACCOUNT_MIN_OUTCOMES
                and failure_ratio >= UNHEALTHY_ACCOUNT_FAILURE_RATIO
            )
            if isinstance(error, ModelIntegrityError):
                affected_model = error.requested_model or required_model
                if affected_model:
                    slot.model_cooldown_until[affected_model] = max(
                        slot.model_cooldown_until.get(affected_model, 0),
                        now + MODEL_INTEGRITY_COOLDOWN,
                    )
                # A substituted/unsupported model proves nothing about token
                # validity. Keep the account usable for every other model.
                slot.disabled = False
                applied_delay = 0
            elif code in {ErrorCode.AUTH_INVALID, ErrorCode.PREMIUM_REQUIRED}:
                slot.disabled = True
                applied_delay = 0
            else:
                delay = retry_after
                if code == ErrorCode.EMPTY_TEXT:
                    # The upstream library recommends one immediate retry, but
                    # failover already performs that retry on another account.
                    # Re-selecting the same persistently empty account on the
                    # next request caused the visible cooldown/503 loop.
                    delay = max(delay or 0, EMPTY_TEXT_COOLDOWN)
                if health_quarantined:
                    delay = max(delay or 0, UNHEALTHY_ACCOUNT_COOLDOWN)
                if delay is None:
                    delay = DEFAULT_DENIAL_COOLDOWN if retryable is False else DEFAULT_TRANSIENT_COOLDOWN
                if (
                    len(self._slots) == 1
                    and retryable is not False
                    and code in {ErrorCode.HTTP_ERROR, ErrorCode.NOTION_ERROR}
                ):
                    # There is no alternate account to protect with a long
                    # cooldown. Retry once quickly, then fail promptly instead
                    # of keeping the Codex turn open for several minutes.
                    delay = min(delay, SINGLE_ACCOUNT_TRANSIENT_COOLDOWN)
                applied_delay = max(0, delay)
                slot.cooldown_until = max(slot.cooldown_until, now + applied_delay)
            signature = slot.last_error_code
            self._recent_failures.append((now, slot.account_id, signature))
            while self._recent_failures and self._recent_failures[0][0] < now - GLOBAL_FAILURE_WINDOW:
                self._recent_failures.popleft()
            matching_accounts = {
                account_id
                for _, account_id, failure_signature in self._recent_failures
                if failure_signature == signature
            }
            circuit_opened = len(matching_accounts) >= GLOBAL_FAILURE_THRESHOLD
            if circuit_opened:
                self._global_cooldown_until = max(
                    self._global_cooldown_until,
                    now + (
                        retry_after
                        if retry_after is not None
                        else DEFAULT_TRANSIENT_COOLDOWN
                    ),
                )
            self._save_state()
            log_event(
                log,
                "account_request_failed",
                level=logging.WARNING,
                account_number=slot.number,
                account_id=slot.account_id,
                account_file=self._account_file(slot),
                duration_ms=duration_ms,
                failures=slot.failures,
                failure_ratio=round(failure_ratio, 3),
                health_quarantined=health_quarantined,
                disabled=slot.disabled,
                cooldown_seconds=applied_delay,
                **exception_fields(error),
            )
            if circuit_opened:
                log_event(
                    log,
                    "circuit_breaker_opened",
                    level=logging.WARNING,
                    failure_signature=signature,
                    matching_accounts=len(matching_accounts),
                    retry_after=max(0, round(self._global_cooldown_until - now)),
                )


class AccountLease:
    def __init__(
        self,
        pool: NotionAccountPool,
        *,
        preferred_account_id: str | None = None,
        avoid_account_id: str | None = None,
        service_tier: str = "default",
        reasoning_effort: str = MAX_REASONING_EFFORT,
        required_model: str | None = None,
    ) -> None:
        self._pool = pool
        self._preferred_account_id = preferred_account_id
        self._avoid_account_id = avoid_account_id
        self._service_tier = normalize_service_tier(service_tier)
        self._reasoning_effort = normalize_reasoning_effort(reasoning_effort)
        self._required_model = required_model
        self._slot: _AccountSlot | None = None
        self._attempted: set[int] = set()
        self._failures: list[str] = []
        self._recovery_deadline = 0.0
        self._recovery_cycles = 0

    @property
    def client(self) -> NotionAgentClient:
        if self._slot is None:
            raise RuntimeError("Notion account lease is not active")
        return self._slot.client

    @property
    def account_id(self) -> str:
        if self._slot is None:
            raise RuntimeError("Notion account lease is not active")
        return self._slot.account_id

    async def __aenter__(self) -> AccountLease:
        self._recovery_deadline = time.monotonic() + POOL_RECOVERY_WAIT_SECONDS
        self._slot = await self._pool._acquire(
            self._attempted,
            preferred_account_id=self._preferred_account_id,
            avoid_account_id=self._avoid_account_id,
            recovery_deadline=self._recovery_deadline,
            service_tier=self._service_tier,
            reasoning_effort=self._reasoning_effort,
            required_model=self._required_model,
        )
        self._attempted.add(self._slot.number - 1)
        return self

    async def __aexit__(self, *_: object) -> None:
        if self._slot is not None:
            await self._pool._release(self._slot)
            self._slot = None

    async def run(
        self,
        operation: Callable[[NotionAgentClient], Awaitable[T]],
        *,
        retry_operation: Callable[[NotionAgentClient], Awaitable[T]] | None = None,
    ) -> T:
        active_operation = operation
        while True:
            started_at = time.monotonic()
            try:
                result = await asyncio.wait_for(
                    active_operation(self.client),
                    timeout=INFERENCE_TIMEOUT_SECONDS,
                )
                if self._slot is not None:
                    await self._pool._record_success(
                        self._slot,
                        round((time.monotonic() - started_at) * 1000),
                        self._service_tier,
                        self._reasoning_effort,
                        self._required_model,
                    )
                return result
            except asyncio.CancelledError:
                if self._slot is not None:
                    log_event(
                        log,
                        "account_request_cancelled",
                        account_number=self._slot.number,
                        account_id=self._slot.account_id,
                        account_file=self._pool._account_file(self._slot),
                        duration_ms=round((time.monotonic() - started_at) * 1000),
                    )
                raise
            except asyncio.TimeoutError as error:
                if self._slot is not None:
                    log_event(
                        log,
                        "account_request_timed_out",
                        level=logging.WARNING,
                        account_number=self._slot.number,
                        account_id=self._slot.account_id,
                        account_file=self._pool._account_file(self._slot),
                        duration_ms=round((time.monotonic() - started_at) * 1000),
                        timeout_seconds=INFERENCE_TIMEOUT_SECONDS,
                    )
                raise TimeoutError(
                    f"Notion inference exceeded {INFERENCE_TIMEOUT_SECONDS:g} seconds"
                ) from error
            except Exception as error:
                if not is_failover_error(error):
                    if self._slot is not None:
                        log_event(
                            log,
                            "account_request_rejected",
                            level=logging.WARNING,
                            account_number=self._slot.number,
                            account_id=self._slot.account_id,
                            account_file=self._pool._account_file(self._slot),
                            duration_ms=round((time.monotonic() - started_at) * 1000),
                            **exception_fields(error),
                        )
                    raise
                await self._switch_account(
                    error,
                    duration_ms=round((time.monotonic() - started_at) * 1000),
                )
                if retry_operation is not None:
                    active_operation = retry_operation

    async def _switch_account(self, error: Exception, *, duration_ms: int) -> None:
        if self._slot is None:
            raise RuntimeError("Notion account lease is not active")
        code = error.code if isinstance(error, NotionAgentError) else type(error).__name__
        self._failures.append(f"account {self._slot.number}: {code}")
        previous_number = self._slot.number
        previous_id = self._slot.account_id
        previous_file = self._pool._account_file(self._slot)
        await self._pool._record_failure(
            self._slot, error, duration_ms, required_model=self._required_model
        )
        await self._pool._release(self._slot)
        self._slot = None
        # Compare attempts with accounts that can actually serve this request,
        # not the configured pool size. A persistently disabled account (for
        # example, one quarantined after a model-integrity violation) can never
        # be attempted. Counting it previously prevented the retry cycle after
        # every eligible account had transiently failed, causing an avoidable
        # 503 after only two attempts in a three-account pool with one disabled.
        eligible_account_count = sum(
            not slot.disabled
            and self._pool._advertises_model(slot, self._required_model)
            for slot in self._pool._slots
        )
        if len(self._attempted) >= eligible_account_count:
            if (
                self._recovery_cycles < MAX_RECOVERY_CYCLES
                and time.monotonic() < self._recovery_deadline
            ):
                self._recovery_cycles += 1
                log_event(
                    log,
                    "account_pool_retry_cycle",
                    level=logging.WARNING,
                    attempted=len(self._attempted),
                    retry_cycle=self._recovery_cycles,
                    recovery_seconds_remaining=round(
                        self._recovery_deadline - time.monotonic(),
                        3,
                    ),
                )
                self._attempted.clear()
                self._slot = await self._pool._acquire(
                    self._attempted,
                    recovery_deadline=self._recovery_deadline,
                    service_tier=self._service_tier,
                    reasoning_effort=self._reasoning_effort,
                    required_model=self._required_model,
                )
                self._attempted.add(self._slot.number - 1)
                log_event(
                    log,
                    "account_failover",
                    level=logging.WARNING,
                    from_account_number=previous_number,
                    from_account_id=previous_id,
                    from_account_file=previous_file,
                    to_account_number=self._slot.number,
                    to_account_id=self._slot.account_id,
                    to_account_file=self._pool._account_file(self._slot),
                    retry_cycle=True,
                )
                return
            failures = ", ".join(self._failures)
            log_event(
                log,
                "account_pool_exhausted",
                level=logging.ERROR,
                attempted=len(self._attempted),
                eligible_accounts=eligible_account_count,
                last_account_id=previous_id,
                last_account_file=previous_file,
            )
            raise AccountPoolExhausted(
                f"All {eligible_account_count} Notion accounts failed ({failures})"
            ) from error
        self._slot = await self._pool._acquire(
            self._attempted,
            recovery_deadline=self._recovery_deadline,
            service_tier=self._service_tier,
            reasoning_effort=self._reasoning_effort,
            required_model=self._required_model,
        )
        self._attempted.add(self._slot.number - 1)
        log_event(
            log,
            "account_failover",
            level=logging.WARNING,
            from_account_number=previous_number,
            from_account_id=previous_id,
            from_account_file=previous_file,
            to_account_number=self._slot.number,
            to_account_id=self._slot.account_id,
            to_account_file=self._pool._account_file(self._slot),
        )
