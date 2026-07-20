from __future__ import annotations

import argparse
import asyncio
import dataclasses
import hashlib
import json
import os
import shutil
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any

from notion_agent_cli.account import NotionAccount, load_notion_account, save_notion_account
from notion_agent_cli.bootstrap import AmbiguousWorkspaceError, bootstrap_account

from account_pool import discover_account_paths


Bootstrap = Callable[..., Awaitable[NotionAccount]]


def legacy_cookie(data: dict[str, Any]) -> str:
    existing = data.get("full_cookie")
    if isinstance(existing, str) and existing.strip():
        return existing.strip()
    user_id = data.get("user_id") or data.get("notion_user_id") or ""
    browser_id = data.get("browser_id") or data.get("notion_browser_id") or ""
    values = {
        "notion_browser_id": browser_id,
        "device_id": data.get("device_id") or "",
        "notion_user_id": user_id,
        "notion_users": f"[%22{user_id}%22]" if user_id else "",
        "csrf": data.get("csrf") or "",
        "__cf_bm": data.get("__cf_bm") or "",
        "_cfuvid": data.get("_cfuvid") or "",
        "token_v2": data.get("token_v2") or "",
    }
    return "; ".join(f"{name}={value}" for name, value in values.items() if value)


def _write_account(path: Path, account: NotionAccount) -> None:
    backup = path.with_suffix(path.suffix + ".legacy-backup")
    if path.exists() and not backup.exists():
        shutil.copy2(path, backup)
        if os.name != "nt":
            backup.chmod(0o600)
    temporary = path.with_suffix(path.suffix + ".tmp")
    save_notion_account(account, temporary)
    if os.name != "nt":
        temporary.chmod(0o600)
    temporary.replace(path)


async def migrate_accounts(
    account_home: Path,
    *,
    bootstrap: Bootstrap = bootstrap_account,
    delay_seconds: float = 1.0,
    dry_run: bool = False,
) -> dict[str, Any]:
    paths = discover_account_paths(account_home)
    known: dict[str, NotionAccount] = {}
    migrated: list[str] = []
    duplicates: list[str] = []
    failed: list[dict[str, str]] = []
    auto_selected_workspaces: list[str] = []
    network_calls = 0

    for path in paths:
        try:
            account = load_notion_account(path)
        except Exception:
            continue
        fingerprint = hashlib.sha256(account.token_v2.encode()).hexdigest()
        known[fingerprint] = account
        if os.name != "nt" and not dry_run:
            path.chmod(0o600)

    for path in paths:
        try:
            load_notion_account(path)
            continue
        except Exception:
            pass
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            token = data.get("token_v2")
            if not isinstance(token, str) or not token.strip():
                raise ValueError("token_v2 is missing")
            fingerprint = hashlib.sha256(token.encode()).hexdigest()
            cookie = legacy_cookie(data)
            if fingerprint in known:
                account = known[fingerprint]
                if cookie:
                    account = dataclasses.replace(account, full_cookie=cookie)
                duplicates.append(path.name)
            else:
                user_id = data.get("user_id") or data.get("notion_user_id") or None
                browser_id = data.get("browser_id") or data.get("notion_browser_id") or None
                try:
                    account = await bootstrap(
                        token_v2=token,
                        user_id=user_id,
                        browser_id=browser_id,
                    )
                except AmbiguousWorkspaceError as error:
                    names = {workspace.space_name for workspace in error.workspaces}
                    domains = {workspace.domain for workspace in error.workspaces}
                    if len(names) != 1 or len(domains) != 1:
                        raise
                    # Some personal accounts expose the same workspace twice
                    # with no distinguishing domain. The library's explicit
                    # space-name selection is deterministic and picks the
                    # first record, which is the only actionable distinction.
                    account = await bootstrap(
                        token_v2=token,
                        user_id=user_id,
                        browser_id=browser_id,
                        space_name=next(iter(names)),
                    )
                    auto_selected_workspaces.append(path.name)
                if cookie:
                    account = dataclasses.replace(account, full_cookie=cookie)
                known[fingerprint] = account
                network_calls += 1
                if delay_seconds > 0:
                    await asyncio.sleep(delay_seconds)
            if not dry_run:
                _write_account(path, account)
            migrated.append(path.name)
        except Exception as error:
            failed.append({"file": path.name, "error": str(error)})

    return {
        "discovered": len(paths),
        "valid_before": len(paths) - len(migrated) - len(failed),
        "migrated": migrated,
        "duplicates": duplicates,
        "failed": failed,
        "auto_selected_workspaces": auto_selected_workspaces,
        "network_calls": network_calls,
        "dry_run": dry_run,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Migrate legacy Notion sessions safely")
    parser.add_argument(
        "account_home",
        nargs="?",
        type=Path,
        default=Path.home() / ".notionagents",
    )
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--delay", type=float, default=1.0)
    args = parser.parse_args()
    result = asyncio.run(migrate_accounts(
        args.account_home.expanduser(),
        delay_seconds=max(0, args.delay),
        dry_run=args.dry_run,
    ))
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 1 if result["failed"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
