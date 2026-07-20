import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AccountPool,
  AccountPoolError,
  DENIAL_COOLDOWN_MS,
  discoverAccounts,
} from "../src/account-pool.js";
import { ErrorCode, NotionAgentError } from "../src/errors.js";

function discoveryFor(names) {
  return {
    accounts: names.map((id, slot) => ({
      id,
      slot,
      account: { id },
      accountPath: `/accounts/${id}.json`,
      credentialMtimeMs: 1,
      threadStateDirectory: `/threads/${id}`,
      legacy: false,
    })),
    discovered: names.length,
    invalid: [],
    duplicates: [],
  };
}

function createPool(names, options = {}) {
  const events = [];
  const pool = new AccountPool({
    home: "/unused",
    statePath: "/unused/pool-state.json",
    providerFactory: ({ accountId }) => ({
      name: accountId,
      async close() {},
    }),
    diagnostic: (event, fields) => events.push({ event, ...fields }),
    ...options,
  }, discoveryFor(names));
  pool._save = async () => {};
  return { pool, events };
}

test("account pool emits structured lifecycle events across failover", async () => {
  const { pool, events } = createPool(["one", "two"]);
  const result = await pool.execute(async (provider) => {
    if (provider.name === "one") {
      throw new NotionAgentError("HTTP 502", { code: ErrorCode.HTTP_ERROR });
    }
    return "ok";
  });

  assert.equal(result, "ok");
  assert.deepEqual(events.map((event) => event.event), [
    "account_selected",
    "account_request_failed",
    "account_selected",
    "account_failover",
    "account_request_succeeded",
  ]);
  assert.equal(events[0].account_id, "one");
  assert.equal(events[1].error_code, ErrorCode.HTTP_ERROR);
  assert.equal(events[2].selection, "failover");
  assert.equal(events[3].to_account_id, "two");
  assert.equal(events[4].account_id, "two");
});

test("account pool balances requests in round-robin order", async () => {
  const { pool } = createPool(["one", "two", "three"]);
  const selected = [];
  for (let index = 0; index < 4; index += 1) {
    selected.push(await pool.execute(async (provider) => provider.name));
  }
  assert.deepEqual(selected, ["one", "two", "three", "one"]);
});

test("all ten accounts are used before rotation repeats", async () => {
  const names = Array.from({ length: 10 }, (_, index) => `account-${String(index + 1).padStart(2, "0")}`);
  const { pool } = createPool(names);
  const selected = [];
  for (let index = 0; index < 11; index += 1) {
    selected.push(await pool.execute(async (provider) => provider.name));
  }
  assert.deepEqual(selected.slice(0, 10), names);
  assert.equal(selected[10], "account-01");
});

test("one account serializes concurrent requests", async () => {
  const { pool } = createPool(["one"]);
  const order = [];
  let markEntered;
  let releaseFirst;
  const entered = new Promise((resolve) => { markEntered = resolve; });
  const release = new Promise((resolve) => { releaseFirst = resolve; });

  const first = pool.execute(async () => {
    order.push("first-start");
    markEntered();
    await release;
    order.push("first-end");
  });
  await entered;
  const second = pool.execute(async () => {
    order.push("second-start");
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["first-start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first-start", "first-end", "second-start"]);
});

test("concurrent requests use different accounts", async () => {
  const { pool } = createPool(["one", "two"]);
  const active = [];
  let bothEntered;
  let releaseBoth;
  const entered = new Promise((resolve) => { bothEntered = resolve; });
  const release = new Promise((resolve) => { releaseBoth = resolve; });
  const operation = async (provider) => {
    active.push(provider.name);
    if (active.length === 2) bothEntered();
    await release;
  };

  const requests = [pool.execute(operation), pool.execute(operation)];
  await entered;
  assert.deepEqual([...active].sort(), ["one", "two"]);
  releaseBoth();
  await Promise.all(requests);
});

test("affinity does not advance new-turn fairness", async () => {
  const { pool } = createPool(["one", "two", "three"]);
  assert.equal(await pool.execute(async (provider) => provider.name), "one");
  assert.equal(await pool.execute(async (provider) => provider.name, {
    preferredAccountId: "one",
  }), "one");
  assert.equal(await pool.execute(async (provider) => provider.name), "two");
});

test("scheduler state survives restart", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "notioncode-pool-state-"));
  try {
    await writeAccount(path.join(home, "notion_account.json"), "token-one", "user-one");
    await writeAccount(path.join(home, "accounts", "two.json"), "token-two", "user-two");
    const options = {
      home,
      providerFactory: ({ slot }) => ({
        slot,
        async close() {},
      }),
      diagnostic: () => {},
    };

    const first = await AccountPool.create(options);
    assert.equal(await first.execute(async (provider) => provider.slot), 0);
    await first.close();

    const restarted = await AccountPool.create(options);
    assert.equal(await restarted.execute(async (provider) => provider.slot), 1);
    await restarted.close();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("cooldown accounts are skipped", async () => {
  const clock = 1_000_000;
  const { pool } = createPool(["one", "two"], { now: () => clock });
  pool.slots[0].cooldownUntil = clock + 60_000;
  assert.equal(await pool.execute(async (provider) => provider.name), "two");
});

test("Notion failures retry on the next account", async () => {
  const { pool } = createPool(["one", "two"]);
  const attempts = [];
  const result = await pool.execute(async (provider) => {
    attempts.push(provider.name);
    if (provider.name === "one") {
      throw new NotionAgentError("HTTP 502", { code: ErrorCode.HTTP_ERROR });
    }
    return "ok";
  });
  assert.equal(result, "ok");
  assert.deepEqual(attempts, ["one", "two"]);
});

test("non-retryable Notion denials receive a long cooldown", async () => {
  const clock = 1_000_000;
  const { pool } = createPool(["one", "two"], { now: () => clock });
  await pool.execute(async (provider) => {
    if (provider.name === "one") {
      throw new NotionAgentError("temporarily unavailable", {
        code: ErrorCode.NOTION_ERROR,
        subtype: "temporarily-unavailable",
        retryable: false,
      });
    }
    return "ok";
  });
  assert.equal(pool.slots[0].cooldownUntil - clock, DENIAL_COOLDOWN_MS);
});

test("recovery operation replaces failed thread continuation", async () => {
  const { pool } = createPool(["one", "two"]);
  const attempts = [];
  const result = await pool.execute(async (provider) => {
    attempts.push([provider.name, "continuation"]);
    throw new NotionAgentError("HTTP 502", { code: ErrorCode.HTTP_ERROR });
  }, {
    recoveryOperation: async (provider) => {
      attempts.push([provider.name, "recovery"]);
      return "recovered";
    },
  });
  assert.equal(result, "recovered");
  assert.deepEqual(attempts, [["one", "continuation"], ["two", "recovery"]]);
});

test("pool reports exhaustion after trying every account once", async () => {
  const { pool } = createPool(["one", "two"]);
  const attempts = [];
  await assert.rejects(pool.execute(async (provider) => {
    attempts.push(provider.name);
    throw new NotionAgentError("HTTP 502", { code: ErrorCode.HTTP_ERROR });
  }), (error) => error instanceof AccountPoolError && error.code === "pool_exhausted");
  assert.deepEqual(attempts, ["one", "two"]);
  assert.equal(pool.status().busy, 0);
});

test("local validation errors do not switch accounts", async () => {
  const { pool } = createPool(["one", "two"]);
  const attempts = [];
  await assert.rejects(pool.execute(async (provider) => {
    attempts.push(provider.name);
    throw new NotionAgentError("empty prompt", { code: ErrorCode.EMPTY_PROMPT });
  }), NotionAgentError);
  assert.deepEqual(attempts, ["one"]);
});

async function writeAccount(filePath, token, user) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify({
    token_v2: token,
    user_id: user,
    space_id: `space-${user}`,
  }));
}

test("account discovery is ordered and assigns isolated thread directories", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "notioncode-accounts-"));
  try {
    await writeAccount(path.join(home, "notion_account.json"), "token-main", "user-main");
    await writeAccount(path.join(home, "accounts", "b.json"), "token-b", "user-b");
    await writeAccount(path.join(home, "accounts", "a.json"), "token-a", "user-a");
    const discovery = await discoverAccounts(home);
    assert.deepEqual(discovery.accounts.map((entry) => path.basename(entry.accountPath)), [
      "notion_account.json",
      "a.json",
      "b.json",
    ]);
    assert.equal(discovery.accounts[0].threadStateDirectory, path.join(home, "threads"));
    assert.equal(new Set(discovery.accounts.map((entry) => entry.threadStateDirectory)).size, 3);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("account discovery excludes invalid and duplicate sessions", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "notioncode-accounts-"));
  try {
    await writeAccount(path.join(home, "notion_account.json"), "token-main", "same-user");
    await writeAccount(path.join(home, "accounts", "duplicate.json"), "token-new", "same-user");
    await writeFile(path.join(home, "accounts", "invalid.json"), "{}");
    await writeAccount(path.join(home, "accounts", "unique.json"), "token-unique", "unique-user");
    const discovery = await discoverAccounts(home);
    assert.equal(discovery.accounts.length, 2);
    assert.equal(discovery.discovered, 4);
    assert.equal(discovery.duplicates.length, 1);
    assert.equal(discovery.invalid.length, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("account discovery rejects more than ten unique accounts", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "notioncode-accounts-"));
  try {
    for (let index = 0; index < 11; index += 1) {
      await writeAccount(
        path.join(home, "accounts", `account-${String(index).padStart(2, "0")}.json`),
        `token-${index}`,
        `user-${index}`,
      );
    }
    await assert.rejects(discoverAccounts(home), (error) => (
      error instanceof AccountPoolError && error.code === "too_many_accounts"
    ));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("extra discovered files are allowed when one is a duplicate", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "notioncode-accounts-"));
  try {
    await writeAccount(path.join(home, "notion_account.json"), "token-0", "user-0");
    for (let index = 0; index < 10; index += 1) {
      await writeAccount(
        path.join(home, "accounts", `account-${String(index).padStart(2, "0")}.json`),
        `token-${index}`,
        `user-${index}`,
      );
    }
    const discovery = await discoverAccounts(home);
    assert.equal(discovery.discovered, 11);
    assert.equal(discovery.accounts.length, 10);
    assert.equal(discovery.duplicates.length, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
