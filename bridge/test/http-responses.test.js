import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { ConversationSegmentStore } from "../src/conversation-segments.js";
import {
  closeBridgeServer,
  createBridgeRequestHandler,
} from "../src/http-server.js";
import { TurnAffinityStore } from "../src/turn-affinity.js";

function memoryStores() {
  const turnAffinities = new TurnAffinityStore();
  const conversationSegments = new ConversationSegmentStore();
  turnAffinities.save = async () => {};
  conversationSegments.save = async () => {};
  return { turnAffinities, conversationSegments };
}

async function startHarness(accountPool) {
  const diagnostics = [];
  const stores = memoryStores();
  const handler = createBridgeRequestHandler({
    accountPool,
    ...stores,
    diagnostic: (event, fields) => diagnostics.push({ event, ...fields }),
  });
  return {
    server: { listening: false },
    diagnostics,
    handler,
  };
}

async function requestJson(harness, method, route, body) {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  request.method = method;
  request.url = route;
  request.headers = body === undefined ? {} : { "content-type": "application/json" };
  const chunks = [];
  const response = {
    statusCode: 200,
    headers: {},
    destroyed: false,
    writableEnded: false,
    writeHead(status, headers = {}) {
      this.statusCode = status;
      this.headers = { ...headers };
      return this;
    },
    write(chunk) {
      if (chunk !== undefined) chunks.push(Buffer.from(String(chunk)));
      return true;
    },
    end(chunk) {
      if (chunk !== undefined) chunks.push(Buffer.from(String(chunk)));
      this.writableEnded = true;
    },
  };
  await harness.handler(request, response);
  const text = Buffer.concat(chunks).toString("utf8");
  return {
    status: response.statusCode,
    payload: text ? JSON.parse(text) : null,
  };
}

async function postJson(harness, route, body) {
  const { status, payload } = await requestJson(harness, "POST", route, body);
  assert.equal(status, 200, JSON.stringify(payload));
  return payload;
}

test("HTTP request lifecycle emits start and completion diagnostics", async () => {
  const accountPool = {
    status: () => ({ configured: 1 }),
  };
  const harness = await startHarness(accountPool);
  try {
    const response = await requestJson(harness, "GET", "/healthz");
    assert.equal(response.status, 200);
    assert.deepEqual(harness.diagnostics.map((entry) => entry.event), [
      "request_started",
      "request_completed",
    ]);
    assert.equal(harness.diagnostics[0].method, "GET");
    assert.equal(harness.diagnostics[0].path, "/healthz");
    assert.equal(harness.diagnostics[1].status, 200);
    assert.equal(harness.diagnostics[0].request_id, harness.diagnostics[1].request_id);
  } finally {
    await closeBridgeServer(harness.server);
  }
});

test("same Codex turn reuses its account and Notion thread, then replays", async () => {
  const calls = [];
  const replies = [
    '{"tool":"update_plan","arguments":{"plan":[]}}',
    "finished",
  ];
  const preferred = [];
  const provider = {
    async complete(options) {
      calls.push(options);
      return {
        text: replies.shift(),
        thread_id: "notion-thread",
        usage: { input_tokens: 10, output_tokens: 2 },
      };
    },
  };
  const accountPool = {
    status: () => ({ configured: 1 }),
    async execute(operation, options = {}) {
      preferred.push(options.preferredAccountId ?? null);
      return operation(provider, { accountId: "account-a" });
    },
  };
  const harness = await startHarness(accountPool);
  try {
    const first = {
      model: "fable-5",
      input: [{ type: "message", role: "user", content: "task" }],
      tools: [{ type: "function", name: "update_plan", parameters: {} }],
      client_metadata: { turn_id: "codex-turn" },
    };
    await postJson(harness, "/v1/responses", first);
    const second = {
      ...first,
      input: [
        ...first.input,
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
    };
    const response = await postJson(harness, "/v1/responses", second);
    const replay = await postJson(harness, "/v1/responses", second);

    assert.equal(response.output[0].content[0].text, "finished");
    assert.equal(replay.output[0].content[0].text, "finished");
    assert.equal(calls.length, 2);
    assert.deepEqual(preferred, [null, "account-a"]);
    assert.equal(calls[0].threadId, undefined);
    assert.equal(calls[1].threadId, "notion-thread");
    assert.match(calls[1].prompt, /Plan updated/);
    assert.doesNotMatch(calls[1].prompt, /Tool catalog/);
  } finally {
    await closeBridgeServer(harness.server);
  }
});

test("conversation continues across turns and rotates after compaction", async () => {
  const calls = [];
  const preferred = [];
  let newSegments = 0;
  const providers = new Map(["account-a", "account-b"].map((accountId) => [
    accountId,
    {
      async complete(options) {
        calls.push([accountId, options]);
        const isCompaction = options.prompt.includes("handoff checkpoint");
        return {
          text: isCompaction ? "dense summary" : `answer from ${accountId}`,
          thread_id: `thread-${accountId}`,
          usage: { input_tokens: 10, output_tokens: 2 },
        };
      },
    },
  ]));
  const accountPool = {
    status: () => ({ configured: 2 }),
    async execute(operation, options = {}) {
      const requested = options.preferredAccountId ?? null;
      preferred.push(requested);
      const accountId = requested || (newSegments++ === 0 ? "account-a" : "account-b");
      return operation(providers.get(accountId), { accountId });
    },
  };
  const harness = await startHarness(accountPool);
  try {
    const metadata = (turnId) => ({ turn_id: turnId, thread_id: "codex-thread" });
    const firstInput = [{ type: "message", role: "user", content: "first task" }];
    await postJson(harness, "/v1/responses", {
      model: "fable-5",
      input: firstInput,
      client_metadata: metadata("turn-1"),
    });
    const secondInput = [
      ...firstInput,
      { type: "message", role: "assistant", content: "previous answer" },
      { type: "message", role: "user", content: "next request" },
    ];
    await postJson(harness, "/v1/responses", {
      model: "fable-5",
      input: secondInput,
      client_metadata: metadata("turn-2"),
    });
    const compacted = await postJson(harness, "/v1/responses/compact", {
      model: "fable-5",
      input: secondInput,
      client_metadata: metadata("compact-turn"),
    });
    const final = await postJson(harness, "/v1/responses", {
      model: "fable-5",
      input: [
        compacted.output[0],
        { type: "message", role: "user", content: "after compact" },
      ],
      client_metadata: metadata("turn-3"),
    });

    assert.deepEqual(preferred, [null, "account-a", "account-a", null]);
    assert.equal(calls[1][0], "account-a");
    assert.equal(calls[1][1].threadId, "thread-account-a");
    assert.match(calls[1][1].prompt, /next request/);
    assert.doesNotMatch(calls[1][1].prompt, /previous answer/);
    assert.equal(compacted.output[0].type, "compaction");
    assert.equal(calls.at(-1)[0], "account-b");
    assert.equal(calls.at(-1)[1].threadId, undefined);
    assert.match(calls.at(-1)[1].prompt, /dense summary/);
    assert.equal(final.output[0].content[0].text, "answer from account-b");
  } finally {
    await closeBridgeServer(harness.server);
  }
});
