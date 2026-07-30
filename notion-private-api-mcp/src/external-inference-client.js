const PROVIDERS = Object.freeze({
  openrouter: Object.freeze({
    name: "OpenRouter",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    modelsEndpoint: "https://openrouter.ai/api/v1/models",
    envKey: "OPENROUTER_API_KEY",
    defaultModel: "openai/gpt-5.6-sol",
    models: Object.freeze([
      "openai/gpt-5.6-sol",
      "openai/gpt-5.6-sol-pro",
      "anthropic/claude-opus-5-fast",
    ]),
    reasoningStyle: "openrouter",
  }),
  vivgrid: Object.freeze({
    name: "Vivgrid",
    endpoint: "https://api.vivgrid.com/v1/chat/completions",
    modelsEndpoint: "https://api.vivgrid.com/v1/models",
    envKey: "VIVGRID_API_KEY",
    defaultModel: "gpt-5.6-sol",
    models: Object.freeze([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]),
    reasoningStyle: "openai",
  }),
  cerebras: Object.freeze({
    name: "Cerebras",
    endpoint: "https://api.cerebras.ai/v1/chat/completions",
    modelsEndpoint: "https://api.cerebras.ai/v1/models",
    envKey: "CEREBRAS_API_KEY",
    defaultModel: "gpt-oss-120b",
    models: Object.freeze([
      "gpt-oss-120b",
      "zai-glm-4.7",
      "gemma-4-31b",
    ]),
    reasoningStyle: "openai",
  }),
});

const REASONING_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh", "max"]);

function providerConfig(provider) {
  const config = PROVIDERS[provider];
  if (!config) {
    throw new Error(`Unsupported external provider: ${provider}`);
  }
  return config;
}

function safeProviderMessage(payload, apiKey) {
  const candidate = payload?.error?.message ?? payload?.message ?? "Provider returned an error.";
  let message = String(candidate);
  if (apiKey) message = message.replaceAll(apiKey, "[redacted]");
  return message.slice(0, 500);
}

function responseText(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => typeof part === "string" ? part : part?.text ?? "")
      .join("");
  }
  throw new Error("External provider returned no assistant text.");
}

export function externalProviderStatus(env = process.env) {
  return Object.entries(PROVIDERS).map(([id, config]) => ({
    id,
    name: config.name,
    configured: Boolean(env[config.envKey]),
    environment_variable: config.envKey,
    default_model: config.defaultModel,
    models: [...config.models],
  }));
}

export async function discoverExternalModels(provider, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30_000,
} = {}) {
  const config = providerConfig(provider);
  const apiKey = env[config.envKey];
  if (!apiKey) {
    throw new Error(`${config.envKey} is not configured. Run configure-external-provider.ps1 locally and restart Codex.`);
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("This Node.js runtime does not provide fetch().");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(config.modelsEndpoint, {
      method: "GET",
      headers: { authorization: `Bearer ${apiKey}` },
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`${config.name} model discovery timed out after ${timeoutMs} ms.`);
    }
    throw new Error(`${config.name} model discovery failed before a response was received.`);
  } finally {
    clearTimeout(timer);
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`${config.name} returned a non-JSON model catalog (${response.status}).`);
  }
  if (!response.ok) {
    throw new Error(`${config.name} model discovery failed (${response.status}): ${safeProviderMessage(payload, apiKey)}`);
  }
  const entries = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : [];
  const models = [...new Set(entries
    .map((entry) => typeof entry === "string" ? entry : entry?.id)
    .filter((id) => typeof id === "string" && id.trim())
    .map((id) => id.trim()))].sort();
  return { provider, models };
}

export function buildExternalRequest({
  provider,
  model,
  prompt,
  system,
  reasoningEffort,
  maxOutputTokens = 4096,
  verifiedModels = [],
}) {
  const config = providerConfig(provider);
  const selectedModel = model || config.defaultModel;
  if (!config.models.includes(selectedModel) && !verifiedModels.includes(selectedModel)) {
    throw new Error(`Model ${selectedModel} is not allowlisted for ${provider}.`);
  }
  if (reasoningEffort && !REASONING_EFFORTS.has(reasoningEffort)) {
    throw new Error(`Unsupported reasoning effort: ${reasoningEffort}`);
  }
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });
  const body = {
    model: selectedModel,
    messages,
    stream: false,
    max_tokens: maxOutputTokens,
  };
  if (reasoningEffort) {
    if (config.reasoningStyle === "openrouter") {
      body.reasoning = { effort: reasoningEffort };
    } else {
      body.reasoning_effort = reasoningEffort;
    }
  }
  return { config, selectedModel, body };
}

export async function generateExternal(args, {
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = 300_000,
  clock = () => Date.now(),
} = {}) {
  const config = providerConfig(args.provider);
  const apiKey = env[config.envKey];
  if (!apiKey) {
    throw new Error(`${config.envKey} is not configured. Run configure-external-provider.ps1 locally and restart Codex.`);
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("This Node.js runtime does not provide fetch().");
  }
  let verifiedModels = [];
  let modelSource = "static_allowlist";
  if (args.model && !config.models.includes(args.model)) {
    const discovered = await discoverExternalModels(args.provider, {
      env,
      fetchImpl,
      timeoutMs: Math.min(timeoutMs, 30_000),
    });
    verifiedModels = discovered.models;
    modelSource = "live_provider_catalog";
  }
  const { selectedModel, body } = buildExternalRequest({
    ...args,
    verifiedModels,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = clock();
  let response;
  try {
    response = await fetchImpl(config.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`${config.name} request timed out after ${timeoutMs} ms.`);
    }
    throw new Error(`${config.name} request failed before a response was received.`);
  } finally {
    clearTimeout(timer);
  }
  const elapsedMs = Math.max(0, clock() - startedAt);
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`${config.name} returned a non-JSON response (${response.status}).`);
  }
  if (!response.ok) {
    throw new Error(`${config.name} request failed (${response.status}): ${safeProviderMessage(payload, apiKey)}`);
  }
  return {
    provider: args.provider,
    model: selectedModel,
    model_source: modelSource,
    elapsed_ms: elapsedMs,
    text: responseText(payload),
    usage: payload.usage ?? null,
  };
}

export const EXTERNAL_PROVIDER_IDS = Object.freeze(Object.keys(PROVIDERS));
