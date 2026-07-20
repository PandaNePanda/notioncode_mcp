import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ConversationSegmentStore,
  appendOnlyPrefix,
  itemFingerprints,
} from "../src/conversation-segments.js";

test("conversation segments detect append-only history and rewrites", () => {
  const first = itemFingerprints([{ text: "a" }]);
  const extended = itemFingerprints([{ text: "a" }, { text: "b" }]);
  const rewritten = itemFingerprints([{ text: "changed" }]);

  assert.equal(appendOnlyPrefix(first, extended), 1);
  assert.equal(appendOnlyPrefix(first, rewritten), null);
});

test("conversation segments persist only hashed identity and no content", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "notioncode-segments-"));
  const filePath = path.join(directory, "conversation-state.json");
  try {
    const store = new ConversationSegmentStore(filePath);
    store.set("secret-codex-thread", {
      account_id: "account-a",
      notion_thread_id: "notion-thread",
      item_fingerprints: ["hash-a"],
      segment_index: 2,
      awaiting_compacted_history: true,
      turns: 7,
      input_tokens: 100,
      output_tokens: 20,
    });
    await store.save();

    const raw = await readFile(filePath, "utf8");
    assert.doesNotMatch(raw, /secret-codex-thread/);
    assert.equal((await stat(filePath)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(raw).version, 1);

    const restoredStore = new ConversationSegmentStore(filePath);
    await restoredStore.load();
    const restored = restoredStore.get("secret-codex-thread");
    assert.ok(restored);
    assert.equal(restored.account_id, "account-a");
    assert.equal(restored.segment_index, 2);
    assert.equal(restored.awaiting_compacted_history, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
