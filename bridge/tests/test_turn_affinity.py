from __future__ import annotations

import json
import unittest

from turn_affinity import (
    TurnAffinityStore,
    codex_conversation_key,
    codex_request_kind,
    codex_turn_key,
    response_input_count,
    response_input_fingerprint,
)


class TurnAffinityTests(unittest.IsolatedAsyncioTestCase):
    def test_reads_direct_and_encoded_turn_ids(self) -> None:
        self.assertEqual(codex_turn_key({
            "client_metadata": {"turn_id": "direct"},
        }), "direct")
        self.assertEqual(codex_turn_key({
            "client_metadata": {"x-codex-turn-metadata": '{"turn_id":"encoded"}'},
        }), "encoded")

    def test_reads_stable_conversation_and_request_kind(self) -> None:
        body = {"client_metadata": {
            "x-codex-turn-metadata": json.dumps({
                "session_id": "session",
                "thread_id": "thread",
                "request_kind": "compaction",
            }),
        }}
        self.assertEqual(codex_conversation_key(body), "thread")
        self.assertEqual(codex_request_kind(body), "compaction")

    async def test_stores_account_thread_and_input_watermark(self) -> None:
        store = TurnAffinityStore()
        await store.put(
            "turn", account_id="account", notion_thread_id="thread", input_count=3,
            input_fingerprint="fingerprint", completion_text="done",
            input_tokens=10, output_tokens=2,
        )
        item = await store.get("turn")
        self.assertIsNotNone(item)
        self.assertEqual(item.account_id, "account")
        self.assertEqual(item.notion_thread_id, "thread")
        self.assertEqual(item.input_count, 3)
        self.assertEqual(item.completion_text, "done")

    def test_counts_responses_input_items(self) -> None:
        self.assertEqual(response_input_count({"input": [{}, {}, {}]}), 3)
        self.assertEqual(response_input_count({"input": "hello"}), 1)

    def test_input_fingerprint_is_stable_and_content_sensitive(self) -> None:
        first = response_input_fingerprint({"model": "fable-5", "input": [{"text": "a"}]})
        same = response_input_fingerprint({"input": [{"text": "a"}], "model": "fable-5"})
        changed = response_input_fingerprint({"model": "fable-5", "input": [{"text": "b"}]})
        self.assertEqual(first, same)
        self.assertNotEqual(first, changed)


if __name__ == "__main__":
    unittest.main()
