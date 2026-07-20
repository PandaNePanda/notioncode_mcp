import { ErrorCode, NotionAgentError } from "./errors.js";

const INLINE_SECTION_TYPES = new Set([
  "agent-inference",
  "agent-reply",
  "assistant-reply",
]);

function isInteger(value) {
  return Number.isInteger(value) && typeof value !== "boolean";
}

function errorMessage(value, fallback = "unknown notion error") {
  if (typeof value?.message === "string" && value.message) return value.message;
  if (typeof value?.data === "string" && value.data) return value.data;
  if (typeof value === "string" && value) return value;
  return fallback;
}

function contentString(entry, kind) {
  if (!entry || typeof entry !== "object") return "";
  if (typeof entry[kind] === "string") return entry[kind];
  if (typeof entry.content === "string") return entry.content;
  if (typeof entry.value === "string") return entry.value;
  return "";
}

function operationCode(operation) {
  return operation?.o ?? operation?.op ?? operation?.operation;
}

function operationPath(operation) {
  return operation?.p ?? operation?.path;
}

function operationValue(operation) {
  return Object.hasOwn(operation ?? {}, "v") ? operation.v : operation?.value;
}

function normalizedOperationCode(code) {
  if (code === "add") return "a";
  if (code === "append") return "x";
  if (code === "replace") return "p";
  return code;
}

function resultFrom(parser) {
  return {
    text: parser.text,
    thinking: parser.thinking,
    input_tokens: parser.input_tokens,
    output_tokens: parser.output_tokens,
    cache_read_tokens: parser.cache_read_tokens,
    cache_creation_tokens: parser.cache_creation_tokens,
    notion_model: parser.notion_model,
    line_count: parser.line_count,
    event_type_counts: { ...parser.event_type_counts },
  };
}

export class NDJSONStreamParser {
  constructor() {
    this.text = "";
    this.thinking = "";
    this.input_tokens = 0;
    this.output_tokens = 0;
    this.cache_read_tokens = 0;
    this.cache_creation_tokens = 0;
    this.notion_model = null;
    this.line_count = 0;
    this.event_type_counts = Object.create(null);
    this._buffer = "";
    this._sectionCount = 0;
    this._valueCounts = new Map();
    this._valueTypes = new Map();
  }

  feedLine(line) {
    const source = Buffer.isBuffer(line) ? line.toString("utf8") : String(line ?? "");
    if (!source.trim()) return this;

    this.line_count += 1;
    let event;
    try {
      event = JSON.parse(source);
    } catch {
      return this;
    }

    if (!event || typeof event !== "object" || Array.isArray(event)) return this;
    const type = event.type;
    if (typeof type === "string") {
      this.event_type_counts[type] = (this.event_type_counts[type] ?? 0) + 1;
    }

    if (type === "error") {
      throw new NotionAgentError(errorMessage(event), { code: ErrorCode.NOTION_ERROR });
    }
    if (type === "premium-feature-unavailable") {
      throw new NotionAgentError(errorMessage(event, "Premium Notion AI is required."), {
        code: ErrorCode.PREMIUM_REQUIRED,
      });
    }
    if (type === "patch-start") {
      this._handlePatchStart(event);
    } else if (type === "patch") {
      this._handlePatch(event);
    } else if (type === "agent-inference") {
      this._handleLegacyInference(event);
    }
    return this;
  }

  feed(chunk) {
    this._buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
    const lines = this._buffer.split(/\r?\n/);
    this._buffer = lines.pop() ?? "";
    for (const line of lines) this.feedLine(line);
    return this;
  }

  finalize() {
    if (this._buffer) {
      const finalLine = this._buffer;
      this._buffer = "";
      this.feedLine(finalLine);
    }
    return resultFrom(this);
  }

  _handlePatchStart(event) {
    const sections = event?.data?.s;
    if (!Array.isArray(sections)) return;
    this._sectionCount = sections.length;
    this._valueCounts.clear();
    this._valueTypes.clear();
    sections.forEach((section, index) => this._registerSection(index, section));
  }

  _registerSection(index, section) {
    this._valueCounts.set(index, 0);
    if (!section || typeof section !== "object") return;
    if (section.type === "error") this._throwInlineError(section);
    if (!INLINE_SECTION_TYPES.has(section.type)) return;

    const values = Array.isArray(section.value) ? section.value : [];
    for (const entry of values) this._registerValue(index, entry);
  }

  _registerValue(sectionIndex, entry) {
    const valueIndex = this._valueCounts.get(sectionIndex) ?? 0;
    this._valueCounts.set(sectionIndex, valueIndex + 1);
    if (!entry || typeof entry !== "object") return;
    if (typeof entry.type === "string") {
      this._valueTypes.set(`/s/${sectionIndex}/value/${valueIndex}`, entry.type);
    }
    this._absorbInlineEntry(entry);
  }

  _absorbInlineEntry(entry) {
    if (entry?.type === "tool_use") return;
    if (entry?.type === "thinking") {
      this.thinking += contentString(entry, "thinking");
    } else if (entry?.type === "text") {
      this.text += contentString(entry, "text");
    }
  }

  _throwInlineError(section) {
    const detail = section?.value && typeof section.value === "object"
      ? section.value
      : section;
    const subtype = detail.subType ?? detail.subtype ?? section.subType ?? section.subtype ?? null;
    const retryable = detail.isRetryable ?? detail.retryable ?? section.isRetryable ?? section.retryable;
    const code = subtype === "trust-rule-denied"
      ? ErrorCode.TRUST_RULE_DENIED
      : ErrorCode.NOTION_ERROR;
    const message = errorMessage(detail);
    const suffix = retryable === false && code !== ErrorCode.TRUST_RULE_DENIED
      ? " This error is not retryable; back off instead of repeatedly calling the endpoint."
      : "";
    throw new NotionAgentError(`${message}${suffix}`, {
      code,
      subtype,
      retryable: typeof retryable === "boolean" ? retryable : undefined,
    });
  }

  _handlePatch(event) {
    const operations = event.v;
    if (!Array.isArray(operations)) return;
    for (const operation of operations) this._handleOperation(operation);
  }

  _handleOperation(operation) {
    if (!operation || typeof operation !== "object") return;
    const code = normalizedOperationCode(operationCode(operation));
    const path = operationPath(operation);
    const value = operationValue(operation);
    if (typeof path !== "string") return;

    this._collectMetadata(path, value, code);

    if (code === "a" && path === "/s/-") {
      const sections = Array.isArray(value) ? value : [value];
      for (const section of sections) {
        const sectionIndex = this._sectionCount;
        this._sectionCount += 1;
        this._registerSection(sectionIndex, section);
      }
      return;
    }

    const valueAppend = path.match(/^\/s\/(\d+)\/value\/-$/);
    if (code === "a" && valueAppend) {
      const sectionIndex = Number(valueAppend[1]);
      const entries = Array.isArray(value) ? value : [value];
      for (const entry of entries) this._registerValue(sectionIndex, entry);
      return;
    }

    const registered = this._registeredType(path);
    if (!registered || registered.type === "tool_use" || typeof value !== "string") return;
    if (registered.type === "thinking") {
      if (code === "x" || code === "a") this.thinking += value;
      else if (code === "p") this.thinking = value;
    } else if (registered.type === "text") {
      if (code === "x" || code === "a") this.text += value;
      else if (code === "p") this.text = compatibleTextReplacement(this.text, value);
    }
  }

  _registeredType(path) {
    for (const [entryPath, type] of this._valueTypes) {
      if (path === entryPath || path.startsWith(`${entryPath}/`)) return { entryPath, type };
    }
    return null;
  }

  _collectMetadata(path, value, code) {
    if (code !== "a" && code !== "x" && code !== "p") return;
    if (path.endsWith("/inputTokens") && isInteger(value)) this.input_tokens += value;
    else if (path.endsWith("/outputTokens") && isInteger(value)) this.output_tokens += value;
    else if (path.endsWith("/cachedTokensRead") && isInteger(value)) this.cache_read_tokens += value;
    else if (path.endsWith("/cachedTokensCreated") && isInteger(value)) this.cache_creation_tokens += value;
    else if (path.endsWith("/model") && typeof value === "string") this.notion_model = value;
  }

  _handleLegacyInference(event) {
    const data = event.data && typeof event.data === "object" ? event.data : event;
    const values = Array.isArray(data.value) ? data.value : [];
    let nextText = null;
    let nextThinking = null;
    for (const entry of values) {
      if (entry?.type === "text") nextText = contentString(entry, "text");
      else if (entry?.type === "thinking") nextThinking = contentString(entry, "thinking");
    }
    if (nextText !== null) this.text = nextText;
    if (nextThinking !== null) this.thinking = nextThinking;
    if (isInteger(data.inputTokens)) this.input_tokens += data.inputTokens;
    if (isInteger(data.outputTokens)) this.output_tokens += data.outputTokens;
    if (typeof data.model === "string") this.notion_model = data.model;
  }
}

export function compatibleTextReplacement(current, replacement) {
  if (!replacement) return current;
  if (current.startsWith(replacement)) return current;
  if (replacement.startsWith(current)) return replacement;
  return replacement;
}

export function parseNdjsonStream(lines) {
  const parser = new NDJSONStreamParser();
  if (typeof lines === "string" || Buffer.isBuffer(lines)) {
    parser.feed(lines);
  } else {
    for (const line of lines ?? []) parser.feedLine(line);
  }
  return parser.finalize();
}
