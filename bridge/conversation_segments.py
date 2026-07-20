from __future__ import annotations

import asyncio
import hashlib
import json
import os
import time
from contextlib import asynccontextmanager
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, AsyncIterator


CONVERSATION_TTL = 30 * 24 * 60 * 60
MAX_CONVERSATIONS = 500
STATE_VERSION = 1


def conversation_storage_key(key: str) -> str:
    """Return a non-reversible identifier suitable for logs and disk."""
    return hashlib.sha256(key.encode()).hexdigest()


def response_input_fingerprints(body: dict[str, Any]) -> tuple[str, ...]:
    value = body.get("input")
    items = value if isinstance(value, list) else [value] if isinstance(value, str) else []
    return tuple(
        hashlib.sha256(
            json.dumps(item, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        for item in items
    )


def input_prefix_length(
    previous: tuple[str, ...], current: tuple[str, ...]
) -> int | None:
    if len(previous) > len(current) or current[:len(previous)] != previous:
        return None
    return len(previous)


@dataclass(slots=True)
class ConversationSegment:
    account_id: str
    notion_thread_id: str
    input_fingerprints: tuple[str, ...]
    segment_index: int
    awaiting_compacted_history: bool
    turns: int
    input_tokens: int
    output_tokens: int
    updated_at: float


class ConversationSegmentStore:
    """Persistent, content-free mapping from a Codex thread to a Notion segment."""

    def __init__(
        self,
        path: Path | None = None,
        *,
        ttl: int = CONVERSATION_TTL,
        maximum: int = MAX_CONVERSATIONS,
    ) -> None:
        self.path = path
        self.ttl = ttl
        self.maximum = maximum
        self._items: dict[str, ConversationSegment] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._guard = asyncio.Lock()
        self._loaded = False

    async def get(self, key: str | None) -> ConversationSegment | None:
        if key is None:
            return None
        async with self._guard:
            self._load_locked()
            changed = self._cleanup_locked()
            if changed:
                self._save_locked()
            return self._items.get(conversation_storage_key(key))

    async def put(
        self,
        key: str | None,
        *,
        account_id: str,
        notion_thread_id: str,
        input_fingerprints: tuple[str, ...],
        segment_index: int,
        awaiting_compacted_history: bool,
        turns: int,
        input_tokens: int,
        output_tokens: int,
    ) -> None:
        if key is None:
            return
        async with self._guard:
            self._load_locked()
            self._items[conversation_storage_key(key)] = ConversationSegment(
                account_id=account_id,
                notion_thread_id=notion_thread_id,
                input_fingerprints=input_fingerprints,
                segment_index=segment_index,
                awaiting_compacted_history=awaiting_compacted_history,
                turns=turns,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                updated_at=time.time(),
            )
            self._cleanup_locked()
            self._save_locked()

    @asynccontextmanager
    async def lock(self, key: str | None) -> AsyncIterator[None]:
        if key is None:
            yield
            return
        storage_key = conversation_storage_key(key)
        async with self._guard:
            lock = self._locks.setdefault(storage_key, asyncio.Lock())
        async with lock:
            yield

    async def status(self) -> dict[str, Any]:
        async with self._guard:
            self._load_locked()
            changed = self._cleanup_locked()
            if changed:
                self._save_locked()
            return {
                "active": len(self._items),
                "ttl_seconds": self.ttl,
                "maximum": self.maximum,
                "persistent": self.path is not None,
            }

    def _load_locked(self) -> None:
        if self._loaded:
            return
        self._loaded = True
        if self.path is None or not self.path.exists():
            return
        try:
            payload = json.loads(self.path.read_text(encoding="utf8"))
            if payload.get("version") != STATE_VERSION:
                return
            for key, raw in payload.get("conversations", {}).items():
                if not isinstance(key, str) or not isinstance(raw, dict):
                    continue
                self._items[key] = ConversationSegment(
                    account_id=str(raw["account_id"]),
                    notion_thread_id=str(raw["notion_thread_id"]),
                    input_fingerprints=tuple(raw.get("input_fingerprints", [])),
                    segment_index=int(raw.get("segment_index", 0)),
                    awaiting_compacted_history=bool(raw.get("awaiting_compacted_history", False)),
                    turns=int(raw.get("turns", 0)),
                    input_tokens=int(raw.get("input_tokens", 0)),
                    output_tokens=int(raw.get("output_tokens", 0)),
                    updated_at=float(raw.get("updated_at", 0)),
                )
        except (OSError, ValueError, TypeError, KeyError, json.JSONDecodeError):
            # State is an optimization. A corrupt/stale file must never prevent
            # the bridge from creating a clean Notion thread.
            self._items = {}

    def _cleanup_locked(self) -> bool:
        cutoff = time.time() - self.ttl
        before = len(self._items)
        self._items = {
            key: item for key, item in self._items.items() if item.updated_at >= cutoff
        }
        if len(self._items) > self.maximum:
            newest = sorted(
                self._items.items(), key=lambda pair: pair[1].updated_at, reverse=True
            )[:self.maximum]
            self._items = dict(newest)
        stale_locks = [
            key for key, lock in self._locks.items()
            if key not in self._items and not lock.locked()
        ]
        for key in stale_locks:
            self._locks.pop(key, None)
        return len(self._items) != before

    def _save_locked(self) -> None:
        if self.path is None:
            return
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_name(f".{self.path.name}.{os.getpid()}.tmp")
        payload = {
            "version": STATE_VERSION,
            "conversations": {
                key: {**asdict(item), "input_fingerprints": list(item.input_fingerprints)}
                for key, item in self._items.items()
            },
        }
        temporary.write_text(
            json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")),
            encoding="utf8",
        )
        if os.name != "nt":
            temporary.chmod(0o600)
        os.replace(temporary, self.path)
