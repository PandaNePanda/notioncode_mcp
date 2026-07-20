from __future__ import annotations

import contextvars
import hashlib
import json
import logging
from typing import Any


_log_context: contextvars.ContextVar[dict[str, Any]] = contextvars.ContextVar(
    "notion_bridge_log_context",
    default={},
)


def correlation_id(value: str | None, *, length: int = 12) -> str | None:
    """Return a stable, non-reversible identifier suitable for diagnostics."""
    if not value:
        return None
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:length]


def set_log_context(**fields: Any) -> contextvars.Token[dict[str, Any]]:
    context = dict(_log_context.get())
    context.update({key: value for key, value in fields.items() if value is not None})
    return _log_context.set(context)


def reset_log_context(token: contextvars.Token[dict[str, Any]]) -> None:
    _log_context.reset(token)


def exception_fields(error: Exception) -> dict[str, Any]:
    """Extract useful error metadata without logging messages, bodies or credentials."""
    fields: dict[str, Any] = {"error_type": type(error).__name__}
    for source, target in (
        ("code", "error_code"),
        ("subtype", "error_subtype"),
        ("retryable", "retryable"),
    ):
        value = getattr(error, source, None)
        if value is not None and value != "":
            fields[target] = value
    response = getattr(error, "response", None)
    status_code = getattr(response, "status_code", None)
    if status_code is not None:
        fields["http_status"] = status_code
    return fields


def log_event(
    logger: logging.Logger,
    event: str,
    *,
    level: int = logging.INFO,
    **fields: Any,
) -> None:
    payload = {"event": event, **_log_context.get()}
    payload.update({key: value for key, value in fields.items() if value is not None})
    logger.log(
        level,
        json.dumps(payload, ensure_ascii=False, separators=(",", ":"), default=str),
    )
