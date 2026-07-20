import assert from "node:assert/strict";
import test from "node:test";

import {
  buildResponsesPayload,
  flattenResponseTools,
  responseMessageText,
  responsesIncrementalBody,
  responsesIncrementalPrompt,
  responsesPlannerPrompt,
  responsesSseChunks,
  resolveBridgeModel,
} from "../src/server-protocol.js";

test("Codex Fable transport id resolves to Notion Fable", () => {
  assert.equal(resolveBridgeModel("gpt-5.5"), "fable-5");
  assert.equal(resolveBridgeModel("fable-5"), "fable-5");
});

test("input image does not replace or mutate response text", () => {
  const message = {
    type: "message",
    role: "user",
    content: [
      { type: "input_text", text: "keep this exact request" },
      { type: "input_image", image_url: "data:image/png;base64,ignored-here" },
    ],
  };

  assert.equal(responseMessageText(message), "[user]\nkeep this exact request");
});

test("text-only planner prompt remains stable", () => {
  const prompt = responsesPlannerPrompt({
    instructions: "cwd: /root/project",
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "list files" }],
    }],
    tools: [],
  });

  assert.match(prompt, /The local operator's current working directory is \/root\/project\./);
  assert.match(prompt, /\[user\]\nlist files/);
});

test("namespace tools are flattened for native Codex calls", () => {
  const tools = flattenResponseTools([
    {
      type: "namespace",
      name: "multi_agent_v1",
      tools: [{ type: "function", name: "spawn_agent", parameters: {} }],
    },
    { type: "web_search" },
  ]);

  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "multi_agent_v1.spawn_agent");
  assert.equal(tools[0].namespace, "multi_agent_v1");
});

test("structured output is forwarded to the planner", () => {
  const prompt = responsesPlannerPrompt({
    input: "return a status",
    text: {
      format: {
        type: "json_schema",
        name: "status",
        schema: { type: "object", required: ["ok"] },
      },
    },
  });

  assert.match(prompt, /\[user\]\nreturn a status/);
  assert.match(prompt, /"required":\["ok"\]/);
});

test("responses SSE contains the full Codex text event sequence", () => {
  const { response, item } = buildResponsesPayload("done", "fable-5", 8, 2, []);
  const chunks = responsesSseChunks(response, item).join("");

  assert.match(chunks, /event: response\.output_text\.delta/);
  assert.match(chunks, /event: response\.completed/);
  assert.ok(chunks.endsWith("data: [DONE]\n\n"));

  const events = chunks
    .split("\n")
    .filter((line) => line.startsWith("data: {") )
    .map((line) => JSON.parse(line.slice(6)));
  assert.deepEqual(
    events.map((event) => event.sequence_number),
    events.map((_, index) => index),
  );
});

test("responses SSE emits a complete tool call", () => {
  const { response, item } = buildResponsesPayload(
    '{"tool":"update_plan","arguments":{"plan":[]}}',
    "fable-5",
    8,
    2,
    [{ type: "function", name: "update_plan", parameters: {} }],
  );
  const chunks = responsesSseChunks(response, item).join("");

  assert.equal(item.type, "function_call");
  assert.match(chunks, /"name":"update_plan"/);
  assert.match(chunks, /event: response\.output_item\.done/);
});

test("tool-loop continuation sends only the new tool result", () => {
  const body = {
    input: [
      { type: "message", role: "user", content: "task" },
      {
        type: "function_call",
        name: "update_plan",
        call_id: "call-1",
        arguments: "{}",
      },
      {
        type: "function_call_output",
        call_id: "call-1",
        output: "Plan updated",
      },
    ],
    tools: [{ type: "function", name: "update_plan" }],
  };

  const incremental = responsesIncrementalBody(body, 1);
  assert.ok(incremental);
  assert.equal(incremental.input.length, 1);
  assert.equal(incremental.input[0].type, "function_call_output");
  assert.deepEqual(incremental.tools, []);

  const prompt = responsesIncrementalPrompt(incremental);
  assert.match(prompt, /Plan updated/);
  assert.doesNotMatch(prompt, /"name":"update_plan"/);
});

test("compaction item is forwarded into a fresh segment", () => {
  const text = responseMessageText({
    type: "compaction",
    encrypted_content: "checkpoint with image facts",
  });

  assert.match(text, /checkpoint with image facts/);
});
