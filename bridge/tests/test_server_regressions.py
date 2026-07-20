from __future__ import annotations

import unittest
import json
from types import SimpleNamespace

import server
from server import (
    handle_openai_compaction,
    handle_openai_responses,
    responses_message_text,
    responses_incremental_body,
    responses_incremental_prompt,
    responses_payload,
    responses_planner_prompt,
    responses_sse,
    responses_tool_catalog,
    resolve_model,
)
from conversation_segments import ConversationSegmentStore
from turn_affinity import TurnAffinityStore


class ResponsesTextRegressionTests(unittest.TestCase):
    def test_codex_fable_transport_id_resolves_to_notion_fable(self) -> None:
        self.assertEqual(resolve_model("gpt-5.5"), "fable-5")
        self.assertEqual(resolve_model("fable-5"), "fable-5")

    def test_input_image_does_not_replace_or_mutate_text(self) -> None:
        message = {
            "type": "message",
            "role": "user",
            "content": [
                {"type": "input_text", "text": "keep this exact request"},
                {"type": "input_image", "image_url": "data:image/png;base64,ignored-here"},
            ],
        }
        self.assertEqual(responses_message_text(message), "[user]\nkeep this exact request")

    def test_text_only_planner_prompt_remains_stable(self) -> None:
        body = {
            "instructions": "cwd: /root/project",
            "input": [{
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": "list files"}],
            }],
            "tools": [],
        }
        prompt = responses_planner_prompt(body)
        self.assertIn("The local operator's current working directory is /root/project.", prompt)
        self.assertIn("[user]\nlist files", prompt)

    def test_namespace_tools_are_flattened_for_native_codex_calls(self) -> None:
        tools = responses_tool_catalog([{
            "type": "namespace",
            "name": "multi_agent_v1",
            "tools": [{"type": "function", "name": "spawn_agent", "parameters": {}}],
        }, {"type": "web_search"}])
        self.assertEqual(len(tools), 1)
        self.assertEqual(tools[0]["name"], "multi_agent_v1.spawn_agent")
        self.assertEqual(tools[0]["namespace"], "multi_agent_v1")

    def test_structured_output_is_forwarded_to_planner(self) -> None:
        prompt = responses_planner_prompt({
            "input": "return a status",
            "text": {"format": {
                "type": "json_schema",
                "name": "status",
                "schema": {"type": "object", "required": ["ok"]},
            }},
        })
        self.assertIn("[user]\nreturn a status", prompt)
        self.assertIn('"required": ["ok"]', prompt)

    def test_sse_contains_full_codex_text_event_sequence(self) -> None:
        response, item = responses_payload("done", "fable-5", 8, 2, [])
        chunks = b"".join(responses_sse(response, item)).decode()
        self.assertIn("event: response.output_text.delta", chunks)
        self.assertIn("event: response.completed", chunks)
        self.assertTrue(chunks.endswith("data: [DONE]\n\n"))
        events = [
            json.loads(line[6:])
            for line in chunks.splitlines()
            if line.startswith("data: {")
        ]
        self.assertEqual(
            [event["sequence_number"] for event in events],
            list(range(len(events))),
        )

    def test_sse_tool_call_is_complete_for_codex_runtime(self) -> None:
        response, item = responses_payload(
            '{"tool":"update_plan","arguments":{"plan":[]}}',
            "fable-5",
            8,
            2,
            [{"type": "function", "name": "update_plan", "parameters": {}}],
        )
        chunks = b"".join(responses_sse(response, item)).decode()
        self.assertEqual(item["type"], "function_call")
        self.assertIn('"name": "update_plan"', chunks)
        self.assertIn("event: response.output_item.done", chunks)

    def test_tool_loop_continuation_sends_only_new_tool_result(self) -> None:
        body = {
            "input": [
                {"type": "message", "role": "user", "content": "task"},
                {
                    "type": "function_call", "name": "update_plan",
                    "call_id": "call-1", "arguments": "{}",
                },
                {
                    "type": "function_call_output", "call_id": "call-1",
                    "output": "Plan updated",
                },
            ],
            "tools": [{"type": "function", "name": "update_plan"}],
        }
        incremental = responses_incremental_body(body, 1)
        self.assertIsNotNone(incremental)
        self.assertEqual(len(incremental["input"]), 1)
        self.assertEqual(incremental["input"][0]["type"], "function_call_output")
        self.assertEqual(incremental["tools"], [])
        prompt = responses_incremental_prompt(incremental)
        self.assertIn("Plan updated", prompt)
        self.assertNotIn('"name": "update_plan"', prompt)

    def test_compaction_item_is_forwarded_into_a_fresh_segment(self) -> None:
        text = responses_message_text({
            "type": "compaction",
            "encrypted_content": "checkpoint with image facts",
        })
        self.assertIn("checkpoint with image facts", text)


class ResponsesAffinityIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_same_codex_turn_reuses_account_and_notion_thread(self) -> None:
        calls = []
        replies = [
            '{"tool":"update_plan","arguments":{"plan":[]}}',
            "finished",
        ]

        class Client:
            async def complete(self, **kwargs):
                calls.append(kwargs)
                return SimpleNamespace(
                    text=replies.pop(0),
                    thread_id="notion-thread",
                    usage=SimpleNamespace(input_tokens=10, output_tokens=2),
                )

        class Lease:
            account_id = "account-a"

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return None

            async def run(self, operation, *, retry_operation=None):
                return await operation(Client())

        class Pool:
            size = 1

            def __init__(self):
                self.preferred = []

            def lease(self, preferred_account_id=None):
                self.preferred.append(preferred_account_id)
                return Lease()

        pool = Pool()
        original_pool = server.account_pool
        original_affinities = server.turn_affinities
        server.account_pool = pool
        server.turn_affinities = TurnAffinityStore()
        try:
            first = {
                "model": "fable-5",
                "input": [{"type": "message", "role": "user", "content": "task"}],
                "tools": [{"type": "function", "name": "update_plan"}],
                "client_metadata": {"turn_id": "codex-turn"},
            }
            await handle_openai_responses(first, "codex-turn")
            second = {
                **first,
                "input": [
                    *first["input"],
                    {
                        "type": "function_call", "name": "update_plan",
                        "call_id": "call-1", "arguments": "{}",
                    },
                    {
                        "type": "function_call_output", "call_id": "call-1",
                        "output": "Plan updated",
                    },
                ],
            }
            response = await handle_openai_responses(second, "codex-turn")
            replay = await handle_openai_responses(second, "codex-turn")
        finally:
            server.account_pool = original_pool
            server.turn_affinities = original_affinities

        self.assertEqual(response["output"][0]["content"][0]["text"], "finished")
        self.assertEqual(replay["output"][0]["content"][0]["text"], "finished")
        self.assertEqual(len(calls), 2)
        self.assertEqual(pool.preferred, [None, "account-a"])
        self.assertIsNone(calls[0].get("thread_id"))
        self.assertEqual(calls[1]["thread_id"], "notion-thread")
        self.assertIn("Plan updated", calls[1]["prompt"])
        self.assertNotIn("Tool catalog", calls[1]["prompt"])

    async def test_conversation_continues_across_turns_then_rotates_after_compaction(self) -> None:
        calls: list[tuple[str, dict]] = []

        class Client:
            def __init__(self, account_id: str):
                self.account_id = account_id

            async def complete(self, **kwargs):
                calls.append((self.account_id, kwargs))
                is_compaction = "handoff checkpoint" in kwargs["prompt"]
                return SimpleNamespace(
                    text="dense summary" if is_compaction else f"answer from {self.account_id}",
                    thread_id=f"thread-{self.account_id}",
                    usage=SimpleNamespace(input_tokens=10, output_tokens=2),
                )

        class Lease:
            def __init__(self, account_id: str):
                self.account_id = account_id

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return None

            async def run(self, operation, *, retry_operation=None):
                return await operation(Client(self.account_id))

        class Pool:
            size = 2

            def __init__(self):
                self.new_segments = 0
                self.preferred: list[str | None] = []

            def lease(self, preferred_account_id=None):
                self.preferred.append(preferred_account_id)
                if preferred_account_id:
                    return Lease(preferred_account_id)
                account_id = "account-a" if self.new_segments == 0 else "account-b"
                self.new_segments += 1
                return Lease(account_id)

        pool = Pool()
        original_pool = server.account_pool
        original_affinities = server.turn_affinities
        original_segments = server.conversation_segments
        server.account_pool = pool
        server.turn_affinities = TurnAffinityStore()
        server.conversation_segments = ConversationSegmentStore()
        try:
            first_input = [{"type": "message", "role": "user", "content": "first task"}]
            await handle_openai_responses(
                {"model": "fable-5", "input": first_input},
                "turn-1",
                conversation_key="codex-thread",
            )
            second_input = [
                *first_input,
                {"type": "message", "role": "assistant", "content": "previous answer"},
                {"type": "message", "role": "user", "content": "next request"},
            ]
            await handle_openai_responses(
                {"model": "fable-5", "input": second_input},
                "turn-2",
                conversation_key="codex-thread",
            )
            compacted = await handle_openai_compaction(
                {"model": "fable-5", "input": second_input},
                "compact-turn",
                "codex-thread",
            )
            final = await handle_openai_responses(
                {"model": "fable-5", "input": [
                    compacted["output"][0],
                    {"type": "message", "role": "user", "content": "after compact"},
                ]},
                "turn-3",
                conversation_key="codex-thread",
            )
        finally:
            server.account_pool = original_pool
            server.turn_affinities = original_affinities
            server.conversation_segments = original_segments

        self.assertEqual(pool.preferred, [None, "account-a", "account-a", None])
        self.assertEqual(calls[1][0], "account-a")
        self.assertEqual(calls[1][1]["thread_id"], "thread-account-a")
        self.assertIn("next request", calls[1][1]["prompt"])
        self.assertNotIn("previous answer", calls[1][1]["prompt"])
        self.assertEqual(compacted["output"][0]["type"], "compaction")
        self.assertEqual(calls[-1][0], "account-b")
        self.assertNotIn("thread_id", calls[-1][1])
        self.assertIn("dense summary", calls[-1][1]["prompt"])
        self.assertEqual(final["output"][0]["content"][0]["text"], "answer from account-b")


if __name__ == "__main__":
    unittest.main()
