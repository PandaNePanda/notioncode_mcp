from __future__ import annotations

import asyncio
import unittest
import json
from types import SimpleNamespace
from unittest.mock import patch

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
    stream_openai_responses,
)
from conversation_segments import ConversationSegmentStore
from turn_affinity import TurnAffinityStore


class ResponsesTextRegressionTests(unittest.TestCase):
    def test_request_execution_settings_parse_codex_wire_fields(self) -> None:
        body = {
            "reasoning": {"effort": "MAX"},
            "service_tier": "priority",
        }
        self.assertEqual(server.request_reasoning_effort(body), "max")
        self.assertEqual(server.request_service_tier(body), "priority")
        self.assertEqual(server.request_reasoning_effort({}), server.MAX_REASONING_EFFORT)
        self.assertIsNone(server.request_service_tier({}))

    def test_fast_service_tier_keeps_reasoning_independent(self) -> None:
        self.assertEqual(
            server.request_reasoning_effort(
                {"model": "gpt-5.6-sol", "service_tier": "priority"}
            ),
            server.MAX_REASONING_EFFORT,
        )
        self.assertEqual(
            server.request_reasoning_effort(
                {"model": "gpt-5.6-sol-ultrafast", "serviceTier": "PRIORITY"}
            ),
            server.MAX_REASONING_EFFORT,
        )

    def test_fast_service_tier_does_not_override_explicit_reasoning(self) -> None:
        self.assertEqual(
            server.request_reasoning_effort(
                {
                    "model": "gpt-5.6-sol",
                    "reasoning": {"effort": "MAX"},
                    "service_tier": "priority",
                }
            ),
            "max",
        )

    def test_fast_service_tier_does_not_change_legacy_model_default(self) -> None:
        self.assertEqual(
            server.request_reasoning_effort(
                {"model": "gpt-5.5", "service_tier": "priority"}
            ),
            server.MAX_REASONING_EFFORT,
        )

    def test_fast_service_tier_preserves_selected_base_model(self) -> None:
        with patch.object(server.model_catalog, "fast_model_for", return_value="gpt-5.6-luna"):
            self.assertEqual(server.resolve_requested_model("gpt-5.6-sol", "priority"), "gpt-5.6-sol")

    def test_fast_service_tier_keeps_model_when_no_fast_variant_exists(self) -> None:
        with patch.object(server.model_catalog, "fast_model_for", return_value=None):
            self.assertEqual(server.resolve_requested_model("gpt-5.6-sol", "priority"), "gpt-5.6-sol")

    def test_ultrafast_service_tier_preserves_selected_base_model(self) -> None:
        with patch.object(server.model_catalog, "supports_service_tier", return_value=True):
            self.assertEqual(
                server.resolve_requested_model("gpt-5.6-sol", "ultrafast"),
                "gpt-5.6-sol",
            )

    def test_unreleased_ultrafast_service_tier_is_rejected(self) -> None:
        with patch.object(server.model_catalog, "supports_service_tier", return_value=False):
            with self.assertRaisesRegex(ValueError, "not currently advertised"):
                server.resolve_requested_model("gpt-5.6-sol", "ultrafast")

    def test_invalid_reasoning_is_not_silently_changed_to_ultra(self) -> None:
        with self.assertRaisesRegex(ValueError, "unsupported reasoning effort"):
            server.request_reasoning_effort({"reasoning": {"effort": "extreme"}})

    def test_anthropic_messages_route_uses_service_tier_model_resolution(self) -> None:
        with patch.object(server, "resolve_requested_model", return_value="gpt-5.6-luna") as mocked:
            class Request:
                async def json(self):
                    return {"model": "gpt-5.6-sol", "service_tier": "priority"}

            with patch.object(server, "account_pool", None):
                response = asyncio.run(server.anthropic_messages(Request()))

        mocked.assert_called_once_with("gpt-5.6-sol", "priority")
        self.assertEqual(response.status_code, 503)

    def test_chat_completions_route_uses_service_tier_model_resolution(self) -> None:
        with patch.object(server, "resolve_requested_model", return_value="gpt-5.6-luna") as mocked:
            class Request:
                async def json(self):
                    return {
                        "model": "gpt-5.6-sol",
                        "service_tier": "priority",
                        "messages": [{"role": "user", "content": "hello"}],
                    }

            with patch.object(server, "account_pool", None):
                response = asyncio.run(server.completions(Request()))

        mocked.assert_called_once_with("gpt-5.6-sol", "priority")
        self.assertEqual(response.status_code, 503)

    def test_codex_fable_transport_id_resolves_to_notion_fable(self) -> None:
        self.assertEqual(resolve_model("gpt-5.5"), "fable-5")
        self.assertEqual(resolve_model("fable-5"), "fable-5")

    def test_authoritatively_discovered_model_resolves_dynamically(self) -> None:
        dynamic = (*server.SUPPORTED_MODELS, "gpt-5.6-sol-ultrafast")
        with patch.object(server.model_catalog, "model_ids", return_value=dynamic):
            self.assertEqual(
                resolve_model("gpt-5.6-sol-ultrafast"),
                "gpt-5.6-sol-ultrafast",
            )

    def test_opus_aliases_resolve_to_notion_opus_5(self) -> None:
        self.assertEqual(resolve_model("opus-5"), "opus-5")
        self.assertEqual(resolve_model("opus"), "opus-5")
        self.assertEqual(resolve_model("claude-opus-5"), "opus-5")
        self.assertEqual(resolve_model("best"), "opus-5")

    def test_forced_opus_replaces_every_requested_model(self) -> None:
        with patch.object(server, "FORCED_MODEL_ID", "opus-5"):
            self.assertEqual(resolve_model("gpt-5.5"), "opus-5")
            self.assertEqual(resolve_model("fable-5"), "opus-5")
            self.assertEqual(resolve_model("gpt-5.6-sol"), "opus-5")
            self.assertEqual(resolve_model("opus-5"), "opus-5")

    def test_notion_model_stays_explicit_on_continuation(self) -> None:
        config = server.notion_transcript.build_config_value(
            notion_model="agave-flan",
            is_subsequent_turn=True,
        )
        self.assertEqual(config["model"], "agave-flan")
        self.assertIs(config["modelFromUser"], True)

    def test_models_endpoint_includes_speed_tier_metadata(self) -> None:
        payload = asyncio.run(server.models())
        sol = next(item for item in payload["data"] if item["id"] == "gpt-5.6-sol")
        self.assertEqual(sol["additional_speed_tiers"], ["fast"])
        self.assertEqual(
            [tier["id"] for tier in sol["service_tiers"]],
            ["priority"],
        )

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
        self.assertIn("The local operator's current working directory is ", prompt)
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

    def test_detects_malformed_textual_tool_call(self) -> None:
        text = '{"tool":"exec_command","arguments":{"cmd":"bash -lc "cd /opt/app""}}'
        tools = [{"type": "function", "name": "exec_command", "parameters": {}}]
        self.assertEqual(
            server.extract_malformed_responses_tool(text, tools),
            "exec_command",
        )

    def test_detects_tool_with_noop_invoke_body_as_malformed(self) -> None:
        text = '{"tool":"exec_command">\n{"function":"noop"}\n</invoke>'
        tools = [{"type": "function", "name": "exec_command", "parameters": {}}]
        self.assertIsNone(server.extract_responses_tool_call(text, tools))
        self.assertEqual(
            server.extract_malformed_responses_tool(text, tools),
            "exec_command",
        )

    def test_converts_antml_parameters_to_function_call(self) -> None:
        text = (
            '{"tool":"exec_command","antml:parameter name="cmd">'
            "bash -lc 'cd /opt/app && sed -n \"1,20p\" main.py'"
            "</parameter>\n"
            '<parameter name="yield_time_ms">120000</parameter>\n</invoke>'
        )
        tools = [{"type": "function", "name": "exec_command", "parameters": {}}]
        tool_type, name, raw_arguments = server.extract_responses_tool_call(text, tools)
        self.assertEqual(tool_type, "function")
        self.assertEqual(name, "exec_command")
        self.assertEqual(
            json.loads(raw_arguments),
            {
                "cmd": "bash -lc 'cd /opt/app && sed -n \"1,20p\" main.py'",
                "yield_time_ms": 120000,
            },
        )
        _response, item = responses_payload(text, "opus-5", 10, 2, tools)
        self.assertEqual(item["type"], "function_call")
        self.assertEqual(item["name"], "exec_command")
        self.assertEqual(json.loads(item["arguments"]), json.loads(raw_arguments))

    def test_converts_standard_anthropic_invoke_markup(self) -> None:
        text = (
            '<invoke name="write_stdin">'
            '<parameter name="session_id">42</parameter>'
            '<parameter name="chars">y\\n</parameter>'
            "</invoke>"
        )
        tools = [{"type": "function", "name": "write_stdin", "parameters": {}}]
        tool_type, name, raw_arguments = server.extract_responses_tool_call(text, tools)
        self.assertEqual(tool_type, "function")
        self.assertEqual(name, "write_stdin")
        self.assertEqual(
            json.loads(raw_arguments),
            {"session_id": 42, "chars": "y\\n"},
        )

    def test_does_not_flag_normal_text_or_valid_tool_call_as_malformed(self) -> None:
        tools = [{"type": "function", "name": "exec_command", "parameters": {}}]
        self.assertIsNone(
            server.extract_malformed_responses_tool(
                "I would use exec_command if another action were needed.", tools
            )
        )
        self.assertIsNone(
            server.extract_malformed_responses_tool(
                '{"tool":"exec_command","arguments":{"cmd":"pwd"}}', tools
            )
        )

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


class ResponsesThinkingStreamTests(unittest.IsolatedAsyncioTestCase):
    async def test_emits_progress_heartbeat_while_notion_is_silent(self) -> None:
        async def slow_handle(
            _body,
            _turn_key,
            *,
            response_id=None,
            **_kwargs,
        ):
            await server.asyncio.sleep(0.03)
            response, _item = responses_payload(
                "done",
                "opus-5",
                10,
                5,
                [],
                response_id=response_id,
            )
            return response

        with (
            patch.object(server, "handle_openai_responses", slow_handle),
            patch.object(server, "REASONING_HEARTBEAT_SECONDS", 0.01),
        ):
            text = b"".join([
                chunk
                async for chunk in stream_openai_responses(
                    {"model": "opus-5", "stream": True},
                    "turn-heartbeat",
                    "conversation-heartbeat",
                    "turn",
                )
            ]).decode()

        self.assertIn("Still working", text)

    async def test_streams_reasoning_before_buffered_tool_call(self) -> None:
        async def fake_handle(
            _body,
            _turn_key,
            *,
            on_thinking_delta_async=None,
            response_id=None,
            **_kwargs,
        ):
            await on_thinking_delta_async("Reading ")
            await on_thinking_delta_async("bench.txt")
            response, _item = responses_payload(
                '{"tool":"update_plan","arguments":{"plan":[]}}',
                "opus-5",
                10,
                5,
                [{"type": "function", "name": "update_plan"}],
                response_id=response_id,
            )
            return response

        with patch.object(server, "handle_openai_responses", fake_handle):
            chunks = [
                chunk
                async for chunk in stream_openai_responses(
                    {"model": "opus-5", "stream": True},
                    "turn-thinking",
                    "conversation-thinking",
                    "turn",
                )
            ]

        text = b"".join(chunks).decode()
        events = [
            json.loads(line.removeprefix("data: "))
            for line in text.splitlines()
            if line.startswith("data: {")
        ]
        event_types = [event["type"] for event in events]
        self.assertLess(
            event_types.index("response.reasoning_summary_text.delta"),
            event_types.index("response.output_item.done"),
        )
        reasoning_deltas = [
            event["delta"]
            for event in events
            if event["type"] == "response.reasoning_summary_text.delta"
        ]
        self.assertEqual(reasoning_deltas[-2:], ["Reading ", "bench.txt"])
        self.assertIn("Notion opus-5 is working", reasoning_deltas[0])
        self.assertNotIn("response.output_text.delta", event_types)
        completed = next(
            event for event in events if event["type"] == "response.completed"
        )
        self.assertEqual(
            [item["type"] for item in completed["response"]["output"]],
            ["reasoning", "function_call"],
        )
        self.assertEqual(
            [event["sequence_number"] for event in events],
            list(range(len(events))),
        )


class ResponsesAffinityIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_reasoning_effort_reaches_image_and_correction_paths(self) -> None:
        calls = []
        replies = [
            "I don't have access to the file system",
            '{"tool":"shell_command","arguments":{"command":"echo ok"}}',
        ]

        class Lease:
            account_id = "account-a"

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return None

            async def run(self, operation, *, retry_operation=None):
                return await operation(SimpleNamespace())

        class Pool:
            size = 1

            def lease(self, preferred_account_id=None, service_tier=None, reasoning_effort=None, required_model=None):
                return Lease()

        async def fake_complete_with_images(_client, **kwargs):
            calls.append(kwargs)
            return SimpleNamespace(
                text=replies.pop(0),
                thread_id="notion-thread",
                usage=SimpleNamespace(input_tokens=10, output_tokens=2),
            )

        original_pool = server.account_pool
        original_affinities = server.turn_affinities
        original_segments = server.conversation_segments
        server.account_pool = Pool()
        server.turn_affinities = TurnAffinityStore()
        server.conversation_segments = ConversationSegmentStore()
        try:
            with (
                patch.object(
                    server,
                    "extract_response_images",
                    return_value=[SimpleNamespace(data=b"image")],
                ),
                patch.object(server, "estimated_image_tokens", return_value=1),
                patch.object(
                    server,
                    "complete_with_images",
                    new=fake_complete_with_images,
                ),
            ):
                response = await handle_openai_responses(
                    {
                        "model": "gpt-5.6-sol",
                        "input": [{"type": "message", "role": "user", "content": "inspect"}],
                        "tools": [{
                            "type": "function",
                            "name": "shell_command",
                            "description": "Run one command",
                            "parameters": {
                                "type": "object",
                                "properties": {"command": {"type": "string"}},
                            },
                        }],
                        "reasoning": {"effort": "max"},
                        "service_tier": "priority",
                    },
                    "image-correction-turn",
                    conversation_key="image-correction-thread",
                )
        finally:
            server.account_pool = original_pool
            server.turn_affinities = original_affinities
            server.conversation_segments = original_segments

        self.assertEqual(len(calls), 2)
        self.assertTrue(all(call["reasoning_effort"] == "max" for call in calls))
        self.assertEqual(calls[1]["thread_id"], "notion-thread")
        self.assertEqual(response["output"][0]["name"], "shell_command")

    async def test_model_change_starts_a_new_notion_thread(self) -> None:
        calls = []

        class Client:
            async def complete(self, **kwargs):
                calls.append(kwargs)
                return SimpleNamespace(
                    text=f"answer from {kwargs['model']}",
                    thread_id=f"thread-{len(calls)}",
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

            def lease(self, preferred_account_id=None, service_tier=None, reasoning_effort=None, required_model=None):
                self.preferred.append(preferred_account_id)
                return Lease()

        pool = Pool()
        original_pool = server.account_pool
        original_affinities = server.turn_affinities
        original_segments = server.conversation_segments
        server.account_pool = pool
        server.turn_affinities = TurnAffinityStore()
        server.conversation_segments = ConversationSegmentStore()
        try:
            first_input = [{"type": "message", "role": "user", "content": "first"}]
            await handle_openai_responses(
                {
                    "model": "fable-5",
                    "input": first_input,
                    "reasoning": {"effort": "max"},
                },
                "turn-1",
                conversation_key="codex-thread",
            )
            second_input = [
                *first_input,
                {"type": "message", "role": "assistant", "content": "previous"},
                {"type": "message", "role": "user", "content": "use opus"},
            ]
            await handle_openai_responses(
                {"model": "opus-5", "input": second_input},
                "turn-2",
                conversation_key="codex-thread",
            )
            segment = await server.conversation_segments.get("codex-thread")
        finally:
            server.account_pool = original_pool
            server.turn_affinities = original_affinities
            server.conversation_segments = original_segments

        self.assertEqual([call["model"] for call in calls], ["fable-5", "opus-5"])
        self.assertNotIn("thread_id", calls[1])
        self.assertEqual(pool.preferred, [None, None])
        self.assertIsNotNone(segment)
        self.assertEqual(segment.model, "opus-5")

    async def test_assistant_message_rewrite_keeps_existing_notion_thread(self) -> None:
        calls = []

        class Client:
            async def complete(self, **kwargs):
                calls.append(kwargs)
                return SimpleNamespace(
                    text=f"answer {len(calls)}",
                    thread_id=f"thread-{len(calls)}",
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

            def lease(self, preferred_account_id=None, service_tier=None, reasoning_effort=None, required_model=None):
                self.preferred.append(preferred_account_id)
                return Lease()

        pool = Pool()
        original_pool = server.account_pool
        original_affinities = server.turn_affinities
        original_segments = server.conversation_segments
        server.account_pool = pool
        server.turn_affinities = TurnAffinityStore()
        server.conversation_segments = ConversationSegmentStore()
        try:
            first_input = [{"type": "message", "role": "user", "content": "first"}]
            await handle_openai_responses(
                {"model": "fable-5", "input": first_input},
                "turn-1",
                conversation_key="codex-thread",
            )
            second_input = [
                *first_input,
                {"type": "message", "role": "assistant", "content": "original answer"},
                {"type": "message", "role": "user", "content": "next"},
            ]
            await handle_openai_responses(
                {"model": "fable-5", "input": second_input},
                "turn-2",
                conversation_key="codex-thread",
            )
            rewritten_input = [
                *first_input,
                {
                    "type": "message",
                    "role": "assistant",
                    "content": "assistant text rewritten by Codex storage",
                },
                {"type": "message", "role": "user", "content": "next"},
                {"type": "message", "role": "assistant", "content": "second answer"},
                {"type": "message", "role": "user", "content": "third"},
            ]
            await handle_openai_responses(
                {"model": "fable-5", "input": rewritten_input},
                "turn-3",
                conversation_key="codex-thread",
            )
        finally:
            server.account_pool = original_pool
            server.turn_affinities = original_affinities
            server.conversation_segments = original_segments

        self.assertEqual(pool.preferred, [None, None, None])
        self.assertNotIn("thread_id", calls[0])
        self.assertEqual(calls[1]["thread_id"], "thread-1")
        self.assertEqual(calls[2]["thread_id"], "thread-2")

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

            def lease(self, preferred_account_id=None, service_tier=None, reasoning_effort=None, required_model=None):
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

    async def test_provider_context_limit_starts_bounded_fresh_segment(self) -> None:
        calls: list[dict] = []

        class Client:
            async def complete(self, **kwargs):
                calls.append(kwargs)
                return SimpleNamespace(
                    text="answer",
                    thread_id=f"thread-{len(calls)}",
                    usage=SimpleNamespace(input_tokens=100, output_tokens=2),
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

            def lease(self, **_kwargs):
                return Lease()

        original_pool = server.account_pool
        original_affinities = server.turn_affinities
        original_segments = server.conversation_segments
        server.account_pool = Pool()
        server.turn_affinities = TurnAffinityStore()
        server.conversation_segments = ConversationSegmentStore()
        try:
            first_input = [{"type": "message", "role": "user", "content": "first task"}]
            with patch.object(server, "SEGMENT_ROLLOVER_INPUT_TOKENS", 50):
                await handle_openai_responses(
                    {"model": "fable-5", "input": first_input},
                    "turn-1",
                    conversation_key="codex-thread",
                )
                await handle_openai_responses(
                    {
                        "model": "fable-5",
                        "input": [
                            *first_input,
                            {"type": "message", "role": "assistant", "content": "old answer"},
                            {"type": "message", "role": "user", "content": "next task"},
                        ],
                    },
                    "turn-2",
                    conversation_key="codex-thread",
                )
        finally:
            server.account_pool = original_pool
            server.turn_affinities = original_affinities
            server.conversation_segments = original_segments

        self.assertEqual(len(calls), 2)
        self.assertNotIn("thread_id", calls[1])
        self.assertIn("fresh provider conversation segment", calls[1]["prompt"])
        self.assertIn("next task", calls[1]["prompt"])

    async def test_new_turn_uses_latency_routing_and_compaction_keeps_affinity(self) -> None:
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
                self.preferred: list[str | None] = []
                self.avoided: list[str | None] = []

            def lease(
                self,
                preferred_account_id=None,
                avoid_account_id=None,
                service_tier=None,
                reasoning_effort=None,
                required_model=None,
            ):
                self.preferred.append(preferred_account_id)
                self.avoided.append(avoid_account_id)
                if preferred_account_id:
                    return Lease(preferred_account_id)
                # Model the real pool after latency measurements: account-a is
                # currently fastest and remains selected for fresh turns.
                return Lease("account-a")

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
                {
                    "model": "fable-5",
                    "input": first_input,
                    "reasoning": {"effort": "max"},
                },
                "turn-1",
                conversation_key="codex-thread",
            )
            second_input = [
                *first_input,
                {"type": "message", "role": "assistant", "content": "previous answer"},
                {"type": "message", "role": "user", "content": "next request"},
            ]
            await handle_openai_responses(
                {
                    "model": "fable-5",
                    "input": second_input,
                    "reasoning": {"effort": "max"},
                },
                "turn-2",
                conversation_key="codex-thread",
            )
            compacted = await handle_openai_compaction(
                {
                    "model": "fable-5",
                    "input": second_input,
                    "reasoning": {"effort": "max"},
                },
                "compact-turn",
                "codex-thread",
            )
            final = await handle_openai_responses(
                {
                    "model": "fable-5",
                    "input": [
                        compacted["output"][0],
                        {"type": "message", "role": "user", "content": "after compact"},
                    ],
                    "reasoning": {"effort": "max"},
                },
                "turn-3",
                conversation_key="codex-thread",
            )
        finally:
            server.account_pool = original_pool
            server.turn_affinities = original_affinities
            server.conversation_segments = original_segments

        self.assertEqual(pool.preferred, [None, None, "account-a", None])
        self.assertEqual(pool.avoided, [None, None, None, None])
        self.assertEqual(calls[0][0], "account-a")
        self.assertEqual(calls[1][0], "account-a")
        self.assertEqual(calls[1][1]["thread_id"], "thread-account-a")
        self.assertIn("next request", calls[1][1]["prompt"])
        self.assertNotIn("previous answer", calls[1][1]["prompt"])
        self.assertEqual(calls[2][0], "account-a")
        self.assertEqual(calls[2][1]["thread_id"], "thread-account-a")
        self.assertEqual(compacted["output"][0]["type"], "compaction")
        self.assertEqual(calls[-1][0], "account-a")
        self.assertNotIn("thread_id", calls[-1][1])
        self.assertIn("dense summary", calls[-1][1]["prompt"])
        self.assertTrue(all(call[1]["reasoning_effort"] == "max" for call in calls))
        self.assertEqual(final["output"][0]["content"][0]["text"], "answer from account-a")


if __name__ == "__main__":
    unittest.main()

class ModelIntegrityValidationTests(unittest.TestCase):
    def test_rejects_an_observed_model_that_differs_from_the_selected_alias(self) -> None:
        result = SimpleNamespace(
            model="oval-kumquat-medium",
            raw={"reported_notion_model": "oval-kumquat-medium"},
            thread_id="thread-wrong-model",
        )
        with patch.object(server.model_catalog, "notion_model_for", return_value="orange-mousse"):
            with self.assertRaises(server.ModelIntegrityError):
                server.validate_selected_model(
                    result,
                    requested_model="gpt-5.6-sol",
                    resolved_model="gpt-5.6-sol",
                    reused_thread=False,
                )

    def test_allows_the_selected_internal_model(self) -> None:
        result = SimpleNamespace(
            model="orange-mousse",
            raw={"reported_notion_model": "orange-mousse"},
            thread_id="thread-correct-model",
        )
        with patch.object(server.model_catalog, "notion_model_for", return_value="orange-mousse"):
            self.assertIs(
                server.validate_selected_model(
                    result,
                    requested_model="gpt-5.6-sol",
                    resolved_model="gpt-5.6-sol",
                    reused_thread=False,
                ),
                result,
            )
