import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadAccount } from "../src/account.js";
import { legacyCookie, migrateAccounts } from "../src/migrate.js";

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value));
}

test("migration preserves legacy browser cookies and creates a backup", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "notioncode-migrate-"));
  try {
    const legacy = path.join(home, "accounts", "account-02.json");
    await writeJson(legacy, {
      token_v2: "token-two",
      notion_user_id: "user-two",
      notion_browser_id: "browser-two",
      __cf_bm: "cloudflare",
    });
    const calls = [];
    const result = await migrateAccounts(home, {
      delaySeconds: 0,
      bootstrapFn: async (options) => {
        calls.push(options);
        return {
          token_v2: options.tokenV2,
          user_id: "user-two",
          space_id: "space-two",
          browser_id: "browser-two",
        };
      },
    });

    const account = await loadAccount(legacy);
    assert.deepEqual(result.migrated, ["account-02.json"]);
    assert.equal(calls.length, 1);
    assert.match(account.full_cookie, /token_v2=token-two/);
    assert.match(account.full_cookie, /__cf_bm=cloudflare/);
    await access(`${legacy}.legacy-backup`);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("duplicate legacy tokens reuse valid metadata without network access", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "notioncode-migrate-"));
  try {
    await writeJson(path.join(home, "notion_account.json"), {
      token_v2: "same-token",
      user_id: "same-user",
      space_id: "same-space",
    });
    const duplicate = path.join(home, "accounts", "account-01.json");
    await writeJson(duplicate, {
      token_v2: "same-token",
      notion_user_id: "same-user",
    });

    const result = await migrateAccounts(home, {
      delaySeconds: 0,
      bootstrapFn: async () => {
        throw new Error("bootstrap must not run for duplicate credentials");
      },
    });

    assert.deepEqual(result.duplicates, ["account-01.json"]);
    assert.equal(result.network_calls, 0);
    assert.equal((await loadAccount(duplicate)).space_id, "same-space");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("legacy cookie is built from all supported legacy fields", () => {
  const cookie = legacyCookie({
    token_v2: "token",
    notion_user_id: "user",
    csrf: "csrf-value",
  });
  assert.match(cookie, /notion_user_id=user/);
  assert.match(cookie, /notion_users=\[%22user%22\]/);
  assert.match(cookie, /csrf=csrf-value/);
});
