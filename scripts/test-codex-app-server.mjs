#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const codexBin = process.env.CODEX_TEST_BIN || findBundledCodex();

function findBundledCodex() {
  const architecture = process.arch === "arm64" ? "aarch64" : "x86_64";
  const platform = process.platform === "win32"
    ? "windows"
    : process.platform === "darwin" ? "darwin" : "linux";
  const executable = process.platform === "win32" ? "codex.exe" : "codex";
  const extensionRoots = [
    path.join(os.homedir(), ".vscode", "extensions"),
    path.join(os.homedir(), ".vscode-server", "extensions"),
  ];
  const matches = extensionRoots.flatMap((extensionRoot) => {
    if (!fs.existsSync(extensionRoot)) return [];
    return fs.readdirSync(extensionRoot)
      .filter((name) => name.startsWith("openai.chatgpt-"))
      .map((name) => path.join(
        extensionRoot, name, "bin", `${platform}-${architecture}`, executable,
      ))
      .filter((candidate) => fs.existsSync(candidate));
  }).sort().reverse();
  return matches[0] || "codex";
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function responsePayload(model, item = null) {
  return {
    id: "resp_codex_contract",
    object: "response",
    status: "completed",
    model,
    output: [item || {
      type: "message",
      id: "msg_codex_contract",
      role: "assistant",
      content: [{
        type: "output_text",
        text: "Codex extension contract OK",
        annotations: [],
      }],
    }],
    usage: {
      input_tokens: 10,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 5,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 15,
    },
  };
}

function writeSse(response, completed) {
  const item = completed.output[0];
  const events = [
    { type: "response.created", response: { ...completed, status: "in_progress", output: [] } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: item.type === "message"
        ? { ...item, content: [] }
        : item.type === "custom_tool_call"
          ? { ...item, input: "" }
          : { ...item, arguments: "" },
    },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: completed },
  ];
  if (item.type === "message") {
    const part = item.content[0];
    events.splice(2, 0,
      { type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part: { ...part, text: "" } },
      { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: part.text },
      { type: "response.output_text.done", item_id: item.id, output_index: 0, content_index: 0, text: part.text },
      { type: "response.content_part.done", item_id: item.id, output_index: 0, content_index: 0, part },
    );
  }
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  events.forEach((event, sequenceNumber) => {
    event.sequence_number = sequenceNumber;
    response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  });
  response.end("data: [DONE]\n\n");
}

const requests = [];
const server = http.createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    if (request.method === "GET" && request.url === "/v1/models") {
      return sendJson(response, 200, { object: "list", data: [] });
    }
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      return sendJson(response, 404, { error: { message: "not found" } });
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push(body);
    const functionLoop = process.env.CODEX_TEST_TOOL_LOOP === "1" && requests.length === 1;
    const customLoop = process.env.CODEX_TEST_CUSTOM_LOOP === "1" && requests.length === 1;
    const payload = functionLoop
      ? responsePayload(body.model, {
          type: "function_call",
          id: "fc_codex_contract",
          call_id: "call_codex_contract",
          name: "update_plan",
          arguments: JSON.stringify({ plan: [{ step: "Contract", status: "completed" }] }),
        })
      : customLoop
        ? responsePayload(body.model, {
            type: "custom_tool_call",
            id: "ctc_codex_contract",
            call_id: "call_codex_contract",
            name: "apply_patch",
            input: "*** Begin Patch\n*** Add File: codex-contract-output.txt\n+patched\n*** End Patch\n",
          })
      : responsePayload(body.model);
    if (body.stream) writeSse(response, payload);
    else sendJson(response, 200, payload);
  });
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "notioncode-codex-"));
const catalog = path.join(root, "config", "codex-models.json").replaceAll("\\", "/");
fs.writeFileSync(path.join(tempHome, "config.toml"), [
  'model = "fable-5"',
  'model_provider = "notion-ai"',
  `model_catalog_json = ${JSON.stringify(catalog)}`,
  "",
  "[model_providers.notion-ai]",
  'name = "Notion AI contract test"',
  `base_url = "http://127.0.0.1:${port}/v1"`,
  'wire_api = "responses"',
  'experimental_bearer_token = "contract-test"',
  "requires_openai_auth = false",
  "",
].join("\n"));

const child = spawn(codexBin, ["--strict-config", "app-server"], {
  cwd: root,
  env: { ...process.env, CODEX_HOME: tempHome },
  stdio: ["pipe", "pipe", "pipe"],
});
const lines = readline.createInterface({ input: child.stdout });
let stderr = "";
child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });

let nextId = 1;
const pending = new Map();
const notifications = [];
lines.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id !== undefined && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
  } else if (message.method) {
    notifications.push(message);
  }
});

function send(method, params) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for ${method}`));
    }, 15000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      if (message.error) reject(new Error(`${method}: ${JSON.stringify(message.error)}`));
      else resolve(message.result);
    });
  });
}

function notify(method, params = {}) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

async function waitFor(method) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const found = notifications.find((message) => message.method === method);
    if (found) return found.params;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${method}`);
}

try {
  await send("initialize", {
    clientInfo: { name: "codex_vscode", title: "Codex VS Code contract test", version: "1.0.0" },
  });
  notify("initialized");
  const started = await send("thread/start", {
    cwd: process.env.CODEX_TEST_CUSTOM_LOOP === "1" ? tempHome : root,
    model: "fable-5",
    modelProvider: "notion-ai",
    approvalPolicy: "never",
    sandbox: process.env.CODEX_TEST_CUSTOM_LOOP === "1" ? "workspace-write" : "read-only",
    ephemeral: true,
  });
  const threadId = started.thread.id;
  await send("turn/start", {
    threadId,
    input: [{ type: "text", text: "Reply with the contract marker only." }],
  });
  const completed = await waitFor("turn/completed");
  if (!requests.length) throw new Error("Codex did not call /v1/responses");
  const request = requests[0];
  if (request.model !== "fable-5" || request.stream !== true) {
    throw new Error(`Unexpected Responses request: ${JSON.stringify(request)}`);
  }
  if (!Array.isArray(request.input) || !Array.isArray(request.tools)) {
    throw new Error("Codex request is missing input or native tool definitions");
  }
  if (process.env.CODEX_TEST_TOOL_LOOP === "1") {
    if (requests.length < 2) throw new Error("Codex did not continue after the tool call");
    const secondInput = requests[1].input || [];
    if (!secondInput.some((item) => item.type === "function_call_output")) {
      throw new Error("Codex did not return the native tool result to the provider");
    }
  }
  if (process.env.CODEX_TEST_CUSTOM_LOOP === "1") {
    if (requests.length < 2) throw new Error("Codex did not continue after the custom tool call");
    const secondInput = requests[1].input || [];
    if (!secondInput.some((item) => item.type === "custom_tool_call_output")) {
      throw new Error("Codex did not return the custom tool result to the provider");
    }
    const patched = path.join(tempHome, "codex-contract-output.txt");
    if (!fs.existsSync(patched) || fs.readFileSync(patched, "utf8") !== "patched\n") {
      throw new Error("Codex app-server did not execute apply_patch correctly");
    }
  }
  if (completed.turn?.status !== "completed") {
    throw new Error(`Turn did not complete: ${JSON.stringify(completed)}`);
  }
  if (process.env.CODEX_TEST_DUMP_REQUEST === "1") {
    console.log(JSON.stringify(
      process.env.CODEX_TEST_DUMP_ALL_REQUESTS === "1" ? requests : request,
      null,
      2,
    ));
  }
  console.log(JSON.stringify({
    ok: true,
    codex: codexBin,
    request: {
      model: request.model,
      stream: request.stream,
      input_items: request.input.length,
      tools: request.tools.map((tool) => `${tool.type}:${tool.name || ""}`),
      fields: Object.keys(request).sort(),
    },
  }, null, 2));
} finally {
  child.kill("SIGTERM");
  server.close();
  fs.rmSync(tempHome, { recursive: true, force: true });
}
