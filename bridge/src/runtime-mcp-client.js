import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function parseEnv(text) {
  const values = {};
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export async function loadRuntimeMcpConfig({
  envPath = path.join(DEFAULT_PROJECT_ROOT, "runtime", ".env"),
} = {}) {
  let values;
  try {
    values = parseEnv(await readFile(envPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("Runtime MCP configuration is missing.");
    }
    throw new Error("Unable to read Runtime MCP configuration.", { cause: error });
  }
  const secret = values.MCP_PATH_SECRET;
  const port = Number(values.PORT ?? 8787);
  if (!secret || secret === "replace-with-a-random-secret") {
    throw new Error("Runtime MCP path secret is not configured.");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Runtime MCP port is invalid.");
  }
  return {
    endpoint: `http://127.0.0.1:${port}/mcp/${encodeURIComponent(secret)}`,
    codeRoot: values.CODE_ROOT || DEFAULT_PROJECT_ROOT,
  };
}

function responsePayload(text) {
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (!line.startsWith("data: ")) continue;
    try {
      return JSON.parse(line.slice(6));
    } catch {
      continue;
    }
  }
  return JSON.parse(text);
}

function combinedAbortSignal(parentSignal, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("Runtime MCP request timed out.")), timeoutMs);
  timeout.unref?.();
  const abort = () => controller.abort(parentSignal?.reason);
  if (parentSignal?.aborted) abort();
  else parentSignal?.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abort);
    },
  };
}

async function postJson(fetchImpl, endpoint, payload, signal, { requireSuccess = true } = {}) {
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? new Error("Runtime MCP request cancelled.");
    throw new Error("Unable to reach the local Runtime MCP service.", { cause: error });
  }
  if (requireSuccess && !response.ok) {
    throw new Error(`Runtime MCP returned HTTP ${response.status}.`);
  }
  return response;
}

export async function callRuntimeTool(name, argumentsValue = {}, {
  envPath,
  fetchImpl = globalThis.fetch,
  signal: parentSignal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("A fetch implementation is required.");
  const { endpoint } = await loadRuntimeMcpConfig({ envPath });
  const abort = combinedAbortSignal(parentSignal, timeoutMs);
  try {
    await postJson(fetchImpl, endpoint, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "notion-fable-proxy", version: "1.0" },
      },
    }, abort.signal);
    await postJson(fetchImpl, endpoint, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }, abort.signal, { requireSuccess: false });
    const toolResponse = await postJson(fetchImpl, endpoint, {
      jsonrpc: "2.0",
      id: 2,
      method: name === "listTools" ? "tools/list" : "tools/call",
      params: name === "listTools" ? {} : { name, arguments: argumentsValue },
    }, abort.signal);
    const payload = responsePayload(await toolResponse.text());
    if (payload?.error) throw new Error(JSON.stringify(payload.error));
    return JSON.stringify(payload?.result ?? {});
  } finally {
    abort.dispose();
  }
}
