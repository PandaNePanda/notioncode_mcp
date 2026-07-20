from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from conversation_segments import (
    ConversationSegmentStore,
    input_prefix_length,
    response_input_fingerprints,
)


class ConversationSegmentTests(unittest.IsolatedAsyncioTestCase):
    def test_detects_append_only_history_and_rewrites(self) -> None:
        first = response_input_fingerprints({"input": [{"text": "a"}]})
        extended = response_input_fingerprints({"input": [{"text": "a"}, {"text": "b"}]})
        rewritten = response_input_fingerprints({"input": [{"text": "changed"}]})
        self.assertEqual(input_prefix_length(first, extended), 1)
        self.assertIsNone(input_prefix_length(first, rewritten))

    async def test_persists_only_hashed_identity_and_no_conversation_content(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "conversation-state.json"
            store = ConversationSegmentStore(path)
            await store.put(
                "secret-codex-thread",
                account_id="account-a",
                notion_thread_id="notion-thread",
                input_fingerprints=("hash-a",),
                segment_index=2,
                awaiting_compacted_history=True,
                turns=7,
                input_tokens=100,
                output_tokens=20,
            )
            raw = path.read_text(encoding="utf8")
            self.assertNotIn("secret-codex-thread", raw)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            payload = json.loads(raw)
            self.assertEqual(payload["version"], 1)

            restored = await ConversationSegmentStore(path).get("secret-codex-thread")
            self.assertIsNotNone(restored)
            self.assertEqual(restored.account_id, "account-a")
            self.assertEqual(restored.segment_index, 2)
            self.assertTrue(restored.awaiting_compacted_history)


if __name__ == "__main__":
    unittest.main()
