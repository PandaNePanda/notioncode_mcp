from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from notion_agent_cli.account import NotionAccount, load_notion_account, save_notion_account

from migrate_accounts import legacy_cookie, migrate_accounts


class AccountMigrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_migrates_legacy_session_and_preserves_browser_cookie(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            home = Path(temporary_directory)
            legacy = home / "accounts" / "account-02.json"
            legacy.parent.mkdir(parents=True)
            legacy.write_text(json.dumps({
                "token_v2": "token-two",
                "notion_user_id": "user-two",
                "notion_browser_id": "browser-two",
                "__cf_bm": "cloudflare",
            }))
            calls = []

            async def bootstrap(**kwargs):
                calls.append(kwargs)
                return NotionAccount(
                    token_v2=kwargs["token_v2"],
                    user_id="user-two",
                    space_id="space-two",
                    browser_id="browser-two",
                )

            result = await migrate_accounts(
                home, bootstrap=bootstrap, delay_seconds=0,
            )
            account = load_notion_account(legacy)
            self.assertEqual(result["migrated"], ["account-02.json"])
            self.assertEqual(len(calls), 1)
            self.assertIn("token_v2=token-two", account.full_cookie)
            self.assertIn("__cf_bm=cloudflare", account.full_cookie)
            self.assertTrue(legacy.with_suffix(".json.legacy-backup").exists())

    async def test_duplicate_legacy_token_reuses_valid_metadata_without_network(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            home = Path(temporary_directory)
            primary = home / "notion_account.json"
            save_notion_account(NotionAccount(
                token_v2="same-token", user_id="same-user", space_id="same-space",
            ), primary)
            duplicate = home / "accounts" / "account-01.json"
            duplicate.parent.mkdir(parents=True)
            duplicate.write_text(json.dumps({
                "token_v2": "same-token", "notion_user_id": "same-user",
            }))

            async def should_not_run(**_kwargs):
                raise AssertionError("bootstrap should not be called for a duplicate token")

            result = await migrate_accounts(
                home, bootstrap=should_not_run, delay_seconds=0,
            )
            self.assertEqual(result["duplicates"], ["account-01.json"])
            self.assertEqual(load_notion_account(duplicate).space_id, "same-space")

    def test_builds_cookie_from_legacy_fields(self) -> None:
        cookie = legacy_cookie({
            "token_v2": "token", "notion_user_id": "user", "csrf": "csrf-value",
        })
        self.assertIn("notion_user_id=user", cookie)
        self.assertIn("notion_users=[%22user%22]", cookie)
        self.assertIn("csrf=csrf-value", cookie)


if __name__ == "__main__":
    unittest.main()
