import assert from "node:assert/strict";
import test from "node:test";
import {
  buildExternalRequest,
  discoverExternalModels,
  externalProviderStatus,
  generateExternal,
} from "./external-inference-client.js";

test("provider status reports only key presence", () => {
  const secret = "secret-that-must-not-appear";
  const status = externalProviderStatus({ OPENROUTER_API_KEY: secret });
  assert.equal(status.find(({ id }) => id === "openrouter").configured, true);
  assert.equal(status.find(({ id }) => id === "vivgrid").configured, false);
  assert.doesNotMatch(JSON.stringify(status), new RegExp(secret));
});

test("OpenRouter uses its verified model id and reasoning object", () => {
  const request = buildExternalRequest({
    provider: "openrouter",
    prompt: "test",
    reasoningEffort: "max",
  });
  assert.equal(request.selectedModel, "openai/gpt-5.6-sol");
  assert.deepEqual(request.body.reasoning, { effort: "max" });
  assert.equal(request.body.reasoning_effort, undefined);
});

test("provider model allowlist rejects invented aliases", () => {
  assert.throws(() => buildExternalRequest({
    provider: "cerebras",
    model: "ultrafast-gpt-6",
    prompt: "test",
  }), /not allowlisted/);
});

test("live provider catalog enables a newly released exact model id", async () => {
  const secret = "local-cerebras-key";
  const calls = [];
  const futureModel = "provider-new-ultrafast-model";
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith("/models")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: futureModel }, { id: "gpt-oss-120b" }] }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: "fast result" } }],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      }),
    };
  };
  const discovered = await discoverExternalModels("cerebras", {
    env: { CEREBRAS_API_KEY: secret },
    fetchImpl,
  });
  assert.deepEqual(discovered.models, ["gpt-oss-120b", futureModel]);
  const result = await generateExternal({
    provider: "cerebras",
    model: futureModel,
    prompt: "test",
  }, {
    env: { CEREBRAS_API_KEY: secret },
    fetchImpl,
  });
  assert.equal(result.model, futureModel);
  assert.equal(result.model_source, "live_provider_catalog");
  assert.equal(JSON.parse(calls.at(-1).options.body).model, futureModel);
  assert.doesNotMatch(JSON.stringify({ discovered, result }), new RegExp(secret));
});

test("generation sends the key only in authorization and returns timing", async () => {
  const secret = "local-test-key";
  let captured;
  const times = [100, 250];
  const result = await generateExternal({
    provider: "vivgrid",
    prompt: "test",
    reasoningEffort: "high",
    maxOutputTokens: 128,
  }, {
    env: { VIVGRID_API_KEY: secret },
    clock: () => times.shift(),
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      };
    },
  });
  assert.equal(captured.url, "https://api.vivgrid.com/v1/chat/completions");
  assert.equal(captured.options.headers.authorization, `Bearer ${secret}`);
  assert.equal(JSON.parse(captured.options.body).reasoning_effort, "high");
  assert.equal(result.elapsed_ms, 150);
  assert.equal(result.text, "ok");
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
});

test("generation fails locally when no provider key exists", async () => {
  await assert.rejects(generateExternal({
    provider: "cerebras",
    prompt: "test",
  }, { env: {} }), /CEREBRAS_API_KEY is not configured/);
});
