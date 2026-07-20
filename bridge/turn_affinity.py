from __future__ import annotations

import asyncio
import hashlib
import json
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any, AsyncIterator


TURN_AFFINITY_TTL = 2 * 60 * 60


@dataclass(slots=True)
class TurnAffinity:
    account_id: str
    notion_thread_id: str
    input_count: int
    input_fingerprint: str
    completion_text: str
    input_tokens: int
    output_tokens: int
    updated_at: float


def codex_turn_key(body: dict[str, Any]) -> str | None:
    return _codex_metadata_value(body, "turn_id")


def codex_conversation_key(body: dict[str, Any]) -> str | None:
    # thread_id distinguishes a main Codex conversation from its subagents.
    # session_id remains a compatibility fallback for older Codex builds.
    return _codex_metadata_value(body, "thread_id") or _codex_metadata_value(
        body, "session_id"
    )


def codex_request_kind(body: dict[str, Any]) -> str:
    return _codex_metadata_value(body, "request_kind") or "turn"


def _codex_metadata_value(body: dict[str, Any], key: str) -> str | None:
    metadata = body.get("client_metadata")
    if not isinstance(metadata, dict):
        return None
    value = metadata.get(key)
    if isinstance(value, str) and value:
        return value
    encoded = metadata.get("x-codex-turn-metadata")
    if isinstance(encoded, str):
        try:
            parsed = json.loads(encoded)
        except json.JSONDecodeError:
            parsed = None
        if isinstance(parsed, dict):
            value = parsed.get(key)
            if isinstance(value, str) and value:
                return value
    return None


def response_input_count(body: dict[str, Any]) -> int:
    value = body.get("input")
    return len(value) if isinstance(value, list) else 1 if isinstance(value, str) else 0


def response_input_fingerprint(body: dict[str, Any]) -> str:
    relevant = {
        key: body.get(key)
        for key in ("model", "instructions", "input", "tools", "tool_choice", "text")
    }
    encoded = json.dumps(relevant, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode()).hexdigest()


class TurnAffinityStore:
    def __init__(self, ttl: int = TURN_AFFINITY_TTL) -> None:
        self.ttl = ttl
        self._items: dict[str, TurnAffinity] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._guard = asyncio.Lock()

    async def get(self, key: str | None) -> TurnAffinity | None:
        if key is None:
            return None
        async with self._guard:
            self._cleanup_locked()
            return self._items.get(key)

    async def put(
        self,
        key: str | None,
        *,
        account_id: str,
        notion_thread_id: str,
        input_count: int,
        input_fingerprint: str,
        completion_text: str,
        input_tokens: int,
        output_tokens: int,
    ) -> None:
        if key is None:
            return
        async with self._guard:
            self._items[key] = TurnAffinity(
                account_id=account_id,
                notion_thread_id=notion_thread_id,
                input_count=input_count,
                input_fingerprint=input_fingerprint,
                completion_text=completion_text,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                updated_at=time.time(),
            )
            self._cleanup_locked()

    @asynccontextmanager
    async def lock(self, key: str | None) -> AsyncIterator[None]:
        if key is None:
            yield
            return
        async with self._guard:
            lock = self._locks.setdefault(key, asyncio.Lock())
        async with lock:
            yield

    async def status(self) -> dict[str, int]:
        async with self._guard:
            self._cleanup_locked()
            return {"active": len(self._items), "ttl_seconds": self.ttl}

    def _cleanup_locked(self) -> None:
        cutoff = time.time() - self.ttl
        stale = [key for key, item in self._items.items() if item.updated_at < cutoff]
        for key in stale:
            self._items.pop(key, None)
            lock = self._locks.get(key)
            if lock is not None and not lock.locked():
                self._locks.pop(key, None)
