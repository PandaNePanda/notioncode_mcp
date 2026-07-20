import assert from "node:assert/strict";
import test from "node:test";

import {
  TurnAffinityStore,
  deriveRequestIdentity,
  requestFingerprint,
  responseInputCount,
} from "../src/turn-affinity.js";

test("request identity reads direct and encoded client turn ids", () => {
  assert.equal(deriveRequestIdentity({
    client_metadata: { turn_id: "direct" },
  }).turnId, "direct");
  assert.equal(deriveRequestIdentity({
    client_metadata: {
      "x-codex-turn-metadata": '{"turn_id":"encoded"}',
    },
  }).turnId, "encoded");
});

test("request identity reads stable conversation and request kind", () => {
  const identity = deriveRequestIdentity({
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({
        session_id: "session",
        thread_id: "thread",
        request_kind: "compaction",
      }),
    },
  });

  assert.equal(identity.conversationKey, "thread");
  assert.equal(identity.requestKind, "compaction");
});

test("turn affinity stores account, thread, and input watermark", () => {
  const store = new TurnAffinityStore();
  store.set("turn", {
    account_id: "account",
    notion_thread_id: "thread",
    input_count: 3,
    input_fingerprint: "fingerprint",
    completion_text: "done",
    input_tokens: 10,
    output_tokens: 2,
  });

  const item = store.get("turn");
  assert.ok(item);
  assert.equal(item.account_id, "account");
  assert.equal(item.notion_thread_id, "thread");
  assert.equal(item.input_count, 3);
  assert.equal(item.completion_text, "done");
});

test("response input count handles arrays and strings", () => {
  assert.equal(responseInputCount({ input: [{}, {}, {}] }), 3);
  assert.equal(responseInputCount({ input: "hello" }), 1);
});

test("request fingerprint is stable and content-sensitive", () => {
  const first = requestFingerprint({ model: "fable-5", input: [{ text: "a" }] });
  const same = requestFingerprint({ input: [{ text: "a" }], model: "fable-5" });
  const changed = requestFingerprint({ model: "fable-5", input: [{ text: "b" }] });

  assert.equal(first, same);
  assert.notEqual(first, changed);
});
