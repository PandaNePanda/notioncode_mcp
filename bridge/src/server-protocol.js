import { randomUUID } from "node:crypto";
import path from "node:path";

export const MODEL_ID = "fable-5";
export const CODEX_FABLE_MODEL_ID = "gpt-5.5";
export const SOL_MODEL_ID = "gpt-5.6-sol";
export const SUPPORTED_MODELS = Object.freeze([MODEL_ID, SOL_MODEL_ID]);

export class ProtocolError extends Error {
  constructor(status, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ProtocolError";
    this.status = status;
    this.code = options.code ?? "invalid_request_error";
    this.param = options.param ?? null;
  }
}

export function resolveBridgeModel(requested) {
  const raw = String(requested || MODEL_ID);
  const normalized = raw.toLowerCase();

  if (normalized === CODEX_FABLE_MODEL_ID || normalized === MODEL_ID) return MODEL_ID;
  if (normalized === SOL_MODEL_ID) return SOL_MODEL_ID;
  if (normalized.includes("opus") || normalized === "best") return SOL_MODEL_ID;
  if (
    normalized.includes("sonnet")
    || normalized.includes("haiku")
    || normalized.includes("fable")
    || normalized === "default"
  ) {
    return MODEL_ID;
  }

  throw new ProtocolError(400, `unsupported model: ${raw}`, {
    code: "invalid_request_error",
  });
}

export function modelList(created = 0) {
  return {
    object: "list",
    data: SUPPORTED_MODELS.map((id) => ({
      id,
      object: "model",
      type: "model",
      created,
      created_at: "2026-01-01T00:00:00Z",
      owned_by: "notion",
      display_name: id === MODEL_ID ? "Fable 5 (Notion)" : "GPT-5.6 Sol (Notion)",
    })),
    has_more: false,
    first_id: SUPPORTED_MODELS[0],
    last_id: SUPPORTED_MODELS.at(-1),
  };
}

function pythonJsonDumps(value) {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (Array.isArray(value)) return `[${value.map(pythonJsonDumps).join(", ")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .map(([key, item]) => `${JSON.stringify(key)}: ${pythonJsonDumps(item)}`)
      .join(", ")}}`;
  }
  return "null";
}

export function estimateAnthropicTokens(body) {
  return Math.max(1, Math.floor(pythonJsonDumps(body ?? {}).length / 4));
}

export function flattenResponseTools(tools) {
  const output = [];
  for (const tool of Array.isArray(tools) ? tools : []) {
    if (!tool || typeof tool !== "object") continue;
    if (tool.type !== "namespace") {
      if (typeof tool.name === "string") output.push({ ...tool });
      continue;
    }
    if (typeof tool.name !== "string" || !Array.isArray(tool.tools)) continue;
    for (const child of tool.tools) {
      if (!child || typeof child !== "object" || typeof child.name !== "string") continue;
      output.push({
        ...child,
        name: `${tool.name}.${child.name}`,
        namespace: tool.name,
      });
    }
  }
  return output;
}

export function requestsWebSearch(tools) {
  return (Array.isArray(tools) ? tools : []).some((tool) =>
    tool?.type === "web_search" && tool.external_web_access !== false);
}

function responseTextContent(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === "string") return item;
      if (
        item
        && typeof item === "object"
        && ["text", "input_text", "output_text"].includes(item.type)
      ) {
        return String(item.text ?? "");
      }
      return "";
    }).join("");
  }
  return String(value ?? "");
}

export function responseMessageText(item) {
  if (!item || typeof item !== "object") return "";
  const kind = String(item.type ?? "message");
  if (kind === "message") {
    const role = String(item.role ?? "user");
    const content = item.content ?? "";
    if (typeof content === "string") return `[${role}]\n${content}`;
    const parts = [];
    if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part === "string") parts.push(part);
        else if (
          part
          && typeof part === "object"
          && ["input_text", "output_text", "text"].includes(part.type)
        ) {
          parts.push(String(part.text ?? ""));
        }
      }
    }
    return `[${role}]\n${parts.join("\n")}`;
  }
  if (kind === "function_call" || kind === "custom_tool_call") {
    const payload = item.arguments ?? item.input ?? "";
    return `[assistant]\nThe planner recommended ${item.name} with input ${payload}.`;
  }
  if (kind === "function_call_output" || kind === "custom_tool_call_output") {
    return `[user]\nThe local operator returned this tool result:\n${responseTextContent(item.output ?? "")}`;
  }
  if (kind === "compaction" || kind === "context_compaction") {
    if (typeof item.encrypted_content === "string" && item.encrypted_content) {
      return `[developer]\n${item.encrypted_content}`;
    }
  }
  return "";
}

function operatorContext(value, codeRoot) {
  const system = typeof value === "string"
    ? value
    : Array.isArray(value)
      ? value
        .filter((item) => item && typeof item === "object" && item.type === "text")
        .map((item) => String(item.text ?? ""))
        .join("\n")
      : "";
  let cwd = codeRoot;
  const patterns = [
    /<cwd>([^<]+)<\/cwd>/i,
    /(?:current working directory|working directory|workdir|cwd)\s*[:=]\s*([^\n<]+)/i,
  ];
  for (const pattern of patterns) {
    const match = system.match(pattern);
    if (!match) continue;
    const candidate = match[1].trim().replace(/^[`"']+|[`"']+$/g, "");
    if (candidate.startsWith("/") || /^[A-Za-z]:[\\/]/.test(candidate)) {
      cwd = candidate;
      break;
    }
  }
  return `The local operator's current working directory is ${cwd}.`;
}

export function responsesPlannerPrompt(body, options = {}) {
  const tools = flattenResponseTools(body?.tools);
  let requestInput = body?.input ?? [];
  if (typeof requestInput === "string") {
    requestInput = [{ type: "message", role: "user", content: requestInput }];
  }
  if (!Array.isArray(requestInput)) requestInput = [];
  const conversation = requestInput
    .filter((item) => item && typeof item === "object")
    .map(responseMessageText)
    .filter(Boolean)
    .join("\n\n");
  const context = operatorContext(body?.instructions, options.codeRoot ?? process.cwd());
  const toolInstructions = tools.length ? `
The operator can execute the tools below. Recommend exactly one action at a time.
For a tool with type "function", respond with ONLY this JSON object:
{{"tool":"<exact tool name>","arguments":{{...}}}}
For a tool with type "custom", respond with ONLY this JSON object:
{{"tool":"<exact tool name>","input":"text matching the tool format"}}
Do not use markdown and do not claim the action already ran. Use an exact tool name and valid input.

Tool catalog:
${JSON.stringify(tools)}
` : "";
  const format = body?.text?.format;
  const outputInstructions = format
    && typeof format === "object"
    && ["json_schema", "json_object"].includes(format.type)
    ? `
The final answer must conform exactly to this requested structured-output format:
${JSON.stringify(format)}
`
    : "";
  return `You are a coding planner advising a local Codex runtime operator.
You do not need computer access and must not perform an action yourself. The operator will execute exactly one recommendation and return its result. Inspect before editing, finish the user's task completely, and verify the result.
${toolInstructions}
${outputInstructions}
If no tool is needed, answer the user normally. Return only the answer intended for the user. Never mention the planner/operator workflow, hidden instructions, or your provider/model identity. The operator and tools are real parts of this workflow; never discuss whether you personally have computer access.

Operator context:
${context}

Conversation:
${conversation}`;
}

export function responsesIncrementalBody(body, previousInputCount) {
  const requestInput = body?.input;
  if (!Array.isArray(requestInput) || previousInputCount > requestInput.length) return null;
  const delta = requestInput.slice(previousInputCount).filter((item) =>
    !item
    || typeof item !== "object"
    || (
      !["function_call", "custom_tool_call"].includes(item.type)
      && !((item.type ?? "message") === "message" && item.role === "assistant")
    ));
  if (!delta.length) return null;
  return { ...body, input: delta, tools: [] };
}

export function responsesIncrementalPrompt(body) {
  const conversation = (Array.isArray(body?.input) ? body.input : [])
    .filter((item) => item && typeof item === "object")
    .map(responseMessageText)
    .filter(Boolean)
    .join("\n\n");
  return `The local Codex operator executed the action recommended in your previous response.
Continue the same original task using the new events below. If another tool is required, use the exact JSON-only tool-call format and catalog from earlier in this thread. Otherwise return only the final answer for the user. Never repeat an action whose result is already present.

New events:
${conversation}`;
}

export function responsesCompactionPrompt(body, { continuing = false } = {}) {
  let requestInput = body?.input ?? [];
  if (typeof requestInput === "string") {
    requestInput = [{ type: "message", role: "user", content: requestInput }];
  }
  const conversation = (Array.isArray(requestInput) ? requestInput : [])
    .filter((item) => item && typeof item === "object")
    .map(responseMessageText)
    .filter(Boolean)
    .join("\n\n");
  const historyNote = continuing
    ? "The complete conversation, including image attachments, is already available earlier in this Notion thread. Use it as the primary source."
    : "Use the transcript supplied below as the source.";
  return `Create a dense handoff checkpoint for another coding agent that will continue this exact task.
Preserve all user requirements and prohibitions, decisions, file paths, edits already made, tool results, failures, tests, image-derived facts, current state, and concrete next steps. Remove repetition and obsolete intermediate chatter. Do not call tools, do not add commentary, and output only the checkpoint text.

${historyNote}

Current transcript events:
${conversation}`;
}

function headerValue(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === "function") return headers.get(name) ?? undefined;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target && value !== undefined && value !== null && value !== "") {
      return String(value);
    }
  }
  return undefined;
}

export function withCodexMetadata(body, headers) {
  const encoded = headerValue(headers, "x-codex-turn-metadata");
  const sessionId = headerValue(headers, "session-id");
  const threadId = headerValue(headers, "thread-id");
  if (!encoded && !sessionId && !threadId) return body;
  const current = body?.client_metadata;
  const metadata = current && typeof current === "object" && !Array.isArray(current)
    ? { ...current }
    : {};
  if (encoded && !("x-codex-turn-metadata" in metadata)) {
    metadata["x-codex-turn-metadata"] = encoded;
  }
  if (sessionId && !("session_id" in metadata)) metadata.session_id = sessionId;
  if (threadId && !("thread_id" in metadata)) metadata.thread_id = threadId;
  return { ...body, client_metadata: metadata };
}

export const CODEX_SUMMARY_PREFIX = "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:";

export function compactResponsesPayload(text, turnKey) {
  const item = {
    type: "compaction",
    encrypted_content: `${CODEX_SUMMARY_PREFIX}\n${text}`,
  };
  if (turnKey) item.internal_chat_message_metadata_passthrough = { turn_id: turnKey };
  return { output: [item] };
}

function responseJsonCandidates(text) {
  const raw = String(text ?? "");
  const candidates = [raw.trim()];
  if (raw.includes("```")) {
    for (const part of raw.split("```")) {
      const candidate = part.trim().replace(/^json/, "").trim();
      if (part.trim()) candidates.push(candidate);
    }
  }
  return candidates;
}

function anthropicTextContent(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return String(value ?? "");
  return value.map((item) => {
    if (typeof item === "string") return item;
    if (item && typeof item === "object" && item.type === "text") {
      return String(item.text ?? "");
    }
    return "";
  }).join("");
}

export function anthropicMessageText(message) {
  if (!message || typeof message !== "object") return "";
  const role = String(message.role ?? "user");
  const content = message.content ?? "";
  if (typeof content === "string") return `[${role}]\n${content}`;
  if (!Array.isArray(content)) return "";

  const parts = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "text") {
      parts.push(String(item.text ?? ""));
    } else if (item.type === "tool_use") {
      parts.push(
        `The planner recommended tool ${item.name} with arguments ${pythonJsonDumps(item.input ?? {})}.`,
      );
    } else if (item.type === "tool_result") {
      const failed = item.is_error ? " (failed)" : "";
      parts.push(
        `The local operator returned this tool result${failed}:\n${anthropicTextContent(item.content ?? "")}`,
      );
    } else if (item.type === "image") {
      parts.push("[An image was supplied to the local operator.]");
    }
  }
  return `[${role}]\n${parts.filter(Boolean).join("\n")}`;
}

export function anthropicPlannerPrompt(body, options = {}) {
  const tools = Array.isArray(body?.tools) ? body.tools : [];
  const catalog = tools
    .filter((tool) => tool && typeof tool === "object" && typeof tool.name === "string")
    .map((tool) => ({
      name: tool.name,
      description: String(tool.description ?? ""),
      input_schema: tool.input_schema && typeof tool.input_schema === "object"
        ? tool.input_schema
        : {},
    }));
  const conversation = (Array.isArray(body?.messages) ? body.messages : [])
    .filter((message) => message && typeof message === "object")
    .map(anthropicMessageText)
    .filter(Boolean)
    .join("\n\n");
  const context = operatorContext(body?.system, options.codeRoot ?? process.cwd());
  const toolInstructions = catalog.length ? `
The operator can execute the tools below. When an action is needed, respond with ONLY one JSON object and no markdown:
{{"tool":"<exact tool name>","arguments":{{...}}}}
Use an exact tool name and arguments matching its input schema. Recommend one action at a time. Do not claim it ran; its result will arrive in the next conversation turn.

Tool catalog:
${JSON.stringify(catalog)}
` : "";
  return `You are a coding planner advising a local runtime operator.
You do not need computer access and must not perform an action yourself. The operator will execute exactly one recommendation and return its result to you. Inspect before editing, make complete changes, and verify them with appropriate commands.
${toolInstructions}
If no tool is needed, answer the user normally. The operator and its tools are real parts of this workflow; never discuss whether you personally have computer access.

Operator context:
${context}

Conversation:
${conversation}`;
}

export function extractAnthropicToolCall(text, tools) {
  const allowed = new Set(
    (Array.isArray(tools) ? tools : [])
      .filter((tool) => tool && typeof tool === "object" && typeof tool.name === "string")
      .map((tool) => tool.name),
  );
  for (const candidate of responseJsonCandidates(text)) {
    let value;
    try {
      value = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const name = value.tool ?? value.name;
    const args = value.arguments ?? value.input ?? {};
    if (allowed.has(name) && args && typeof args === "object" && !Array.isArray(args)) {
      return { name: String(name), arguments: args };
    }
  }
  return null;
}

function anthropicId(prefix) {
  return `${prefix}${randomUUID().replaceAll("-", "")}`;
}

export function buildAnthropicMessage(text, model, inputTokens, outputTokens, tools) {
  const toolCall = extractAnthropicToolCall(text, tools);
  const content = toolCall
    ? [{
      type: "tool_use",
      id: anthropicId("toolu_"),
      name: toolCall.name,
      input: toolCall.arguments,
    }]
    : [{ type: "text", text: String(text ?? "") }];
  return {
    id: anthropicId("msg_"),
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: toolCall ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: Number(inputTokens) || 0,
      output_tokens: Number(outputTokens) || 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

export function anthropicSseChunks(message) {
  const block = message.content[0];
  const start = {
    ...message,
    content: [],
    stop_reason: null,
    stop_sequence: null,
  };
  const events = [
    ["message_start", { type: "message_start", message: start }],
  ];
  if (block.type === "text") {
    events.push(
      ["content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }],
      ["content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: block.text },
      }],
    );
  } else {
    events.push(
      ["content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: {},
        },
      }],
      ["content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify(block.input),
        },
      }],
    );
  }
  events.push(
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", {
      type: "message_delta",
      delta: { stop_reason: message.stop_reason, stop_sequence: null },
      usage: { output_tokens: message.usage.output_tokens },
    }],
    ["message_stop", { type: "message_stop" }],
  );
  return events.map(([name, payload]) =>
    `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
}

export function extractResponseToolCall(text, tools) {
  const byName = new Map(
    (Array.isArray(tools) ? tools : [])
      .filter((tool) => tool && typeof tool === "object" && typeof tool.name === "string")
      .map((tool) => [tool.name, tool]),
  );
  for (const candidate of responseJsonCandidates(text)) {
    let value;
    try {
      value = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const name = value.tool || value.name;
    const tool = byName.get(String(name));
    if (!tool) continue;
    if (String(tool.type ?? "function") === "custom") {
      let input = value.input ?? value.arguments ?? "";
      if (input && typeof input === "object" && !Array.isArray(input)) {
        input = input.command || input.cmd || input.patch || pythonJsonDumps(input);
      }
      return { type: "custom", name: String(name), arguments: String(input) };
    }
    let args = value.arguments ?? value.input ?? {};
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        continue;
      }
    }
    if (args && typeof args === "object" && !Array.isArray(args)) {
      return { type: "function", name: String(name), arguments: pythonJsonDumps(args) };
    }
  }
  return null;
}

export function extractUnavailableResponseTool(text, tools) {
  const allowed = new Set(
    (Array.isArray(tools) ? tools : [])
      .filter((tool) => tool && typeof tool === "object" && typeof tool.name === "string")
      .map((tool) => tool.name),
  );
  for (const candidate of responseJsonCandidates(text)) {
    let value;
    try {
      value = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const name = value.tool || value.name;
    if (
      typeof name === "string"
      && name
      && !allowed.has(name)
      && (Object.hasOwn(value, "arguments") || Object.hasOwn(value, "input"))
    ) {
      return name;
    }
  }
  return null;
}

export function looksLikeAgentRefusal(text) {
  const lowered = String(text ?? "").toLowerCase();
  const markers = [
    "нет доступа к файловой системе",
    "нет доступа к вашему компьютеру",
    "нет доступа к вашему серверу",
    "нет инструментов",
    "не могу выполнить это",
    "не могу запускать shell",
    "i don't have access to the file system",
    "i do not have access to the file system",
    "i can't access your file system",
    "i cannot access your file system",
    "i don't have tools",
    "i do not have tools",
  ];
  return markers.some((marker) => lowered.includes(marker));
}

function defaultResponseId(prefix) {
  return `${prefix}${randomUUID().replaceAll("-", "")}`;
}

export function buildResponsesPayload(
  text,
  model,
  inputTokens,
  outputTokens,
  tools,
  { idFactory = defaultResponseId, now = () => Math.floor(Date.now() / 1000) } = {},
) {
  const responseId = idFactory("resp_");
  const call = extractResponseToolCall(text, tools);
  let item;
  let endTurn;
  if (call) {
    const callId = idFactory("call_");
    if (call.type === "custom") {
      item = {
        type: "custom_tool_call",
        id: idFactory("ctc_"),
        call_id: callId,
        name: call.name,
        input: call.arguments,
      };
    } else {
      item = {
        type: "function_call",
        id: idFactory("fc_"),
        call_id: callId,
        name: call.name,
        arguments: call.arguments,
      };
    }
    endTurn = false;
  } else {
    item = {
      type: "message",
      id: idFactory("msg_"),
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    };
    endTurn = true;
  }
  const usage = {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: inputTokens + outputTokens,
  };
  const response = {
    id: responseId,
    object: "response",
    created_at: now(),
    status: "completed",
    error: null,
    incomplete_details: null,
    model,
    output: [item],
    usage,
    end_turn: endTurn,
  };
  return { response, item };
}

export function responsesSseChunks(response, item) {
  const created = { ...response, status: "in_progress", output: [] };
  const itemStarted = { ...item };
  const events = [{ type: "response.created", response: created }];
  if (item.type === "message") {
    const part = item.content[0];
    itemStarted.content = [];
    const emptyPart = { ...part, text: "" };
    events.push(
      { type: "response.output_item.added", output_index: 0, item: itemStarted },
      {
        type: "response.content_part.added",
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        part: emptyPart,
      },
      {
        type: "response.output_text.delta",
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        delta: part.text,
      },
      {
        type: "response.output_text.done",
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        text: part.text,
      },
      {
        type: "response.content_part.done",
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        part,
      },
    );
  } else {
    if (item.type === "function_call") itemStarted.arguments = "";
    else if (item.type === "custom_tool_call") itemStarted.input = "";
    events.push({
      type: "response.output_item.added",
      output_index: 0,
      item: itemStarted,
    });
  }
  events.push(
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response },
  );
  return [
    ...events.map((event, sequenceNumber) => {
      const sequenced = { ...event, sequence_number: sequenceNumber };
      return `event: ${event.type}\ndata: ${JSON.stringify(sequenced)}\n\n`;
    }),
    "data: [DONE]\n\n",
  ];
}

export function protocolErrorBody(error, dialect = "openai") {
  const message = error?.message || "Unexpected bridge error.";
  if (dialect === "anthropic") {
    return {
      type: "error",
      error: {
        type: error?.code ?? "api_error",
        message,
      },
    };
  }
  return {
    error: {
      message,
      type: error?.code ?? "api_error",
    },
  };
}

export function chatTextContent(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return String(value ?? "");
  return value.map((item) => {
    if (typeof item === "string") return item;
    if (!item || typeof item !== "object") return "";
    if (["text", "input_text", "output_text"].includes(item.type)) {
      return String(item.text ?? "");
    }
    return "";
  }).join("");
}

export function buildChatPrompt(messages, tools, { workflowId = "" } = {}) {
  const systems = [];
  const conversation = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== "object") continue;
    const role = String(message.role ?? "user");
    const content = chatTextContent(message.content ?? "");
    if (!content) continue;
    if (role === "system") systems.push(content);
    else conversation.push(`[${role}]\n${content}`);
  }
  if (Array.isArray(tools) && tools.length > 0 && !workflowId) {
    systems.push(
      "You have access to the following external tools.\n"
      + "When a tool is needed, respond with ONLY one JSON object in this exact form "
      + "and no markdown or explanation: "
      + '{"tool":"<exact tool name>","arguments":{...}}\n'
      + "Use an exact tool name from the catalog and valid arguments. "
      + "Do not claim that a tool was called unless you emit this JSON object.\n"
      + `Tool catalog:\n${JSON.stringify(tools, null, 2)}`,
    );
  }
  return {
    system: systems.length ? systems.join("\n\n") : null,
    prompt: conversation.join("\n\n"),
  };
}

export function extractChatToolCall(text, tools) {
  if (!Array.isArray(tools) || tools.length === 0) return null;
  const allowed = new Set(tools
    .filter((item) => item && typeof item === "object"
      && item.function && typeof item.function === "object"
      && typeof item.function.name === "string")
    .map((item) => item.function.name));
  const raw = String(text ?? "");
  const candidates = [raw.trim()];
  if (raw.includes("```")) {
    candidates.push(...raw.split("```").map((part) => part.trim()).filter(Boolean));
  }
  const start = raw.indexOf("<tool_call>");
  if (start >= 0) {
    const contentStart = start + "<tool_call>".length;
    const end = raw.indexOf("</tool_call>", contentStart);
    if (end >= 0) candidates.unshift(raw.slice(contentStart, end).trim());
  }
  for (const candidate of candidates) {
    let value;
    try {
      value = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const name = value.tool ?? value.name;
    const args = value.arguments ?? value.parameters ?? {};
    if (allowed.has(name) && args && typeof args === "object" && !Array.isArray(args)) {
      return { name: String(name), arguments: args };
    }
  }
  return null;
}

export function extractWorkflowCall(text) {
  const raw = String(text ?? "");
  const candidates = [raw.trim()];
  const match = raw.match(/\{\s*"function"\s*:[\s\S]*?\}\s*$/);
  if (match) candidates.push(match[0].trim());
  for (const candidate of candidates) {
    let value;
    try {
      value = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const functionName = value.function;
    const args = value.args;
    if (typeof functionName !== "string" || !args || typeof args !== "object"
      || Array.isArray(args)) continue;
    if (functionName.endsWith(".runTool")) {
      const name = args.toolName;
      const toolArguments = args.toolArguments ?? {};
      if (typeof name === "string" && toolArguments && typeof toolArguments === "object"
        && !Array.isArray(toolArguments)) {
        return { name, arguments: toolArguments };
      }
    }
    if (functionName.endsWith(".listTools")) return { name: "listTools", arguments: {} };
  }
  return null;
}

export function extractPlannerAction(text) {
  for (const candidate of responseJsonCandidates(text)) {
    let value;
    try {
      value = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (value && typeof value === "object" && !Array.isArray(value)
      && typeof value.action === "string") return value;
  }
  return null;
}

function plannerCwd(system, codeRoot) {
  let cwd = path.resolve(codeRoot);
  const raw = typeof system === "string" ? system : "";
  const patterns = [
    /<cwd>([^<]+)<\/cwd>/i,
    /(?:working directory|workdir|cwd)\s*[:=]\s*([^\n]+)/i,
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (!match) continue;
    const candidate = match[1].trim().replace(/^[`"']+|[`"']+$/g, "");
    const resolved = path.resolve(candidate);
    const relative = path.relative(path.resolve(codeRoot), resolved);
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      cwd = candidate;
      break;
    }
  }
  return cwd;
}

export function plannerPrompt(task, system, { codeRoot = process.cwd() } = {}) {
  const cwd = plannerCwd(system, codeRoot);
  return `You are a coding planner advising a local runtime operator.
You do not need computer access and must not perform an action yourself. The operator will execute exactly one recommendation and return its result to you.

Respond with ONLY one JSON object, without markdown or explanation. Allowed forms:
{{"action":"list_files","directory":"path"}}
{{"action":"read_file","file_path":"path","max_bytes":500000}}
{{"action":"write_file","file_path":"path","content":"complete file content"}}
{{"action":"edit_file","file_path":"path","old_text":"exact text","new_text":"replacement","replace_all":false}}
{{"action":"run_shell","command":"command","cwd":"path","timeout_ms":30000}}
{{"action":"final","message":"concise result for the user"}}

Paths are relative to ${codeRoot}. The current OpenCode working directory is ${cwd}; express it relative to ${codeRoot} when choosing paths. Inspect existing files before editing, make the requested changes, run appropriate tests, and use final only when the task is genuinely complete.

Task from the user:
${task}`;
}

export function plannerTool(action) {
  const kind = action?.action;
  if (kind === "list_files") {
    return { name: "list_files", arguments: { directory: String(action.directory ?? ".") } };
  }
  if (kind === "read_file") {
    const args = { file_path: String(action.file_path ?? "") };
    if (Number.isInteger(action.max_bytes)) args.max_bytes = action.max_bytes;
    return { name: "read_file", arguments: args };
  }
  if (kind === "write_file") {
    return {
      name: "write_file",
      arguments: {
        file_path: String(action.file_path ?? ""),
        content: String(action.content ?? ""),
      },
    };
  }
  if (kind === "edit_file") {
    return {
      name: "edit_file",
      arguments: {
        file_path: String(action.file_path ?? ""),
        old_text: String(action.old_text ?? ""),
        new_text: String(action.new_text ?? ""),
        replace_all: Boolean(action.replace_all),
      },
    };
  }
  if (kind === "run_shell") {
    const args = {
      command: String(action.command ?? ""),
      cwd: String(action.cwd ?? "."),
    };
    if (Number.isInteger(action.timeout_ms)) args.timeout_ms = action.timeout_ms;
    return { name: "run_shell", arguments: args };
  }
  return null;
}

function chatId(prefix) {
  return `${prefix}${randomUUID().replaceAll("-", "")}`;
}

export function buildChatCompletion(text, model, inputTokens, outputTokens, tools, {
  now = () => Math.floor(Date.now() / 1000),
} = {}) {
  const toolCall = extractChatToolCall(text, tools);
  const message = toolCall
    ? {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: chatId("call_"),
        type: "function",
        function: {
          name: toolCall.name,
          arguments: JSON.stringify(toolCall.arguments),
        },
      }],
    }
    : { role: "assistant", content: String(text ?? "") };
  const promptTokens = Number(inputTokens) || 0;
  const completionTokens = Number(outputTokens) || 0;
  return {
    id: chatId("chatcmpl-"),
    object: "chat.completion",
    created: now(),
    model,
    choices: [{
      index: 0,
      message,
      finish_reason: toolCall ? "tool_calls" : "stop",
    }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

function chatCompletionChunk(text, model, finishReason, toolCall, now) {
  let delta = { role: "assistant", content: text };
  if (toolCall) {
    delta = {
      role: "assistant",
      content: null,
      tool_calls: [{
        index: 0,
        id: chatId("call_"),
        type: "function",
        function: {
          name: toolCall.name,
          arguments: JSON.stringify(toolCall.arguments),
        },
      }],
    };
  }
  return {
    id: chatId("chatcmpl-"),
    object: "chat.completion.chunk",
    created: now(),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

export function chatSseData(text, model, {
  finishReason = null,
  toolCall = null,
  now = () => Math.floor(Date.now() / 1000),
} = {}) {
  return `data: ${JSON.stringify(chatCompletionChunk(
    String(text ?? ""),
    model,
    finishReason,
    toolCall,
    now,
  ))}\n\n`;
}

export const CHAT_SSE_DONE = "data: [DONE]\n\n";

export function chatSseChunks(text, model, tools, {
  now = () => Math.floor(Date.now() / 1000),
} = {}) {
  const toolCall = extractChatToolCall(text, tools);
  const chunks = [];
  if (toolCall) {
    chunks.push(chatCompletionChunk("", model, null, toolCall, now));
  } else if (!Array.isArray(tools) || tools.length === 0 || String(text ?? "")) {
    chunks.push(chatCompletionChunk(String(text ?? ""), model, null, null, now));
  }
  chunks.push(chatCompletionChunk("", model, toolCall ? "tool_calls" : "stop", null, now));
  return [
    ...chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`),
    CHAT_SSE_DONE,
  ];
}
