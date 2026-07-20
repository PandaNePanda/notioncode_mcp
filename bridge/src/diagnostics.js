import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { NotionAgentError } from "./errors.js";

const contextStorage = new AsyncLocalStorage();

const ANSI = Object.freeze({
  reset: "\u001b[0m",
  gray: "\u001b[90m",
  red: "\u001b[31m",
  yellow: "\u001b[33m",
  green: "\u001b[32m",
  cyan: "\u001b[36m",
});

const SENSITIVE_FIELD = /(^|_)(authorization|cookie|cookies|token|token_v2|prompt|content|request_body|response_body|body)(_|$)/i;

export function correlationId(value, length = 12) {
  return createHash("sha256").update(String(value ?? "")).digest("hex").slice(0, length);
}

export function withDiagnosticContext(fields, callback) {
  return contextStorage.run({ ...(contextStorage.getStore() ?? {}), ...fields }, callback);
}

export function diagnosticContext() {
  return { ...(contextStorage.getStore() ?? {}) };
}

export function safeErrorMetadata(error) {
  const result = {
    error_type: error?.constructor?.name ?? typeof error,
  };
  if (error instanceof NotionAgentError) {
    result.error_code = error.code;
    if (error.subtype) result.error_subtype = error.subtype;
    result.retryable = Boolean(error.retryable);
    if (Number.isInteger(error.responseStatus)) {
      result.response_status = error.responseStatus;
    }
  }
  return result;
}

function sanitizeValue(value, key = "") {
  if (SENSITIVE_FIELD.test(key)) return "[redacted]";
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        sanitizeValue(childValue, childKey),
      ]),
    );
  }
  return value;
}

function diagnosticLevel(event) {
  if (/failed|error|exhausted/.test(event)) return "ERROR";
  if (/cooling|circuit|denied|rejected|cancelled/.test(event)) return "WARNING";
  return "INFO";
}

function levelColor(level) {
  if (level === "ERROR") return ANSI.red;
  if (level === "WARNING") return ANSI.yellow;
  return ANSI.green;
}

function fieldText(value) {
  if (typeof value === "string" && /^[A-Za-z0-9._:/-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

export function formatDiagnostic(record, { color = false } = {}) {
  const level = diagnosticLevel(record.event);
  const levelLabel = `${level}:`.padEnd(9);
  const prefix = color
    ? `${levelColor(level)}${levelLabel}${ANSI.reset}`
    : levelLabel;
  const event = color ? `${ANSI.cyan}${record.event}${ANSI.reset}` : record.event;
  const fields = Object.entries(record)
    .filter(([key]) => key !== "event")
    .map(([key, value]) => `${key}=${fieldText(value)}`)
    .join(" ");
  return `${prefix} [bridge] ${event}${fields ? ` ${fields}` : ""}`;
}

export function writeDiagnostic(
  event,
  fields = {},
  destination = process.stderr,
  { format = process.env.NOTION_LOG_FORMAT, color } = {},
) {
  const record = {
    event,
    ...diagnosticContext(),
    ...fields,
  };
  const safeRecord = sanitizeValue(record);
  const pretty = format === "pretty" || (!format && destination?.isTTY === true);
  if (!pretty) {
    destination.write(`${JSON.stringify(safeRecord)}\n`);
    return safeRecord;
  }
  const colorsEnabled = color ?? (
    !("NO_COLOR" in process.env)
    && process.env.NOTION_COLOR !== "0"
    && (process.env.NOTION_COLOR === "1" || destination?.isTTY === true)
  );
  destination.write(`${formatDiagnostic(safeRecord, { color: colorsEnabled })}\n`);
  return safeRecord;
}
