import { readFile } from "node:fs/promises";
import { atomicWriteJson } from "./files.js";
import { fingerprint, KeyedMutex } from "./state.js";

export const TURN_AFFINITY_TTL_MS = 2 * 60 * 60 * 1000;

function lowerCaseHeaders(headers = {}) {
  if (typeof headers?.entries === "function") {
    return Object.fromEntries([...headers.entries()].map(([key, value]) => [key.toLowerCase(), value]));
  }
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
}

function parseMetadataHeader(value) {
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function deriveRequestIdentity(input = {}, headers = {}) {
  const normalizedHeaders = lowerCaseHeaders(headers);
  const clientMetadata = input?.client_metadata
    && typeof input.client_metadata === "object"
    && !Array.isArray(input.client_metadata)
    ? input.client_metadata
    : {};
  const embedded = {
    ...parseMetadataHeader(normalizedHeaders["x-codex-turn-metadata"]),
    ...parseMetadataHeader(clientMetadata["x-codex-turn-metadata"]),
  };
  const read = (...names) => {
    for (const name of names) {
      const value = input[name]
        ?? clientMetadata[name]
        ?? embedded[name]
        ?? normalizedHeaders[name.replaceAll("_", "-")];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return null;
  };
  const turnId = read("turn_id", "turn-id");
  const threadId = read("thread_id", "thread-id");
  const sessionId = read("session_id", "session-id");
  const requestKind = read("request_kind", "request-kind") || "turn";
  const conversationId = threadId || sessionId;
  return {
    turnId,
    threadId,
    sessionId,
    requestKind,
    conversationKey: conversationId,
    turnKey: turnId ? fingerprint(`${requestKind}:${turnId}`) : null,
  };
}

export function responseInputCount(body) {
  if (typeof body?.input === "string") return 1;
  return Array.isArray(body?.input) ? body.input.length : 0;
}

export function requestFingerprint(request) {
  return fingerprint({
    model: request?.model ?? null,
    instructions: request?.instructions ?? null,
    input: request?.input ?? null,
    tools: request?.tools ?? null,
    tool_choice: request?.tool_choice ?? null,
    text: request?.text ?? null,
  });
}

export class TurnAffinityStore {
  #entries = new Map();
  #locks = new KeyedMutex();

  constructor(filePath, { ttlMs = TURN_AFFINITY_TTL_MS, now = () => Date.now() } = {}) {
    this.filePath = filePath;
    this.ttlMs = ttlMs;
    this.now = now;
  }

  async load() {
    let parsed;
    try {
      parsed = JSON.parse(await readFile(this.filePath, "utf8"));
    } catch {
      this.#entries.clear();
      return;
    }
    this.#entries.clear();
    if (parsed?.version !== 1 || !parsed.entries || typeof parsed.entries !== "object") return;
    for (const [key, value] of Object.entries(parsed.entries)) {
      if (value && typeof value === "object") this.#entries.set(key, value);
    }
    this.prune();
  }

  prune() {
    const cutoff = this.now() - this.ttlMs;
    for (const [key, entry] of this.#entries) {
      if (!Number.isFinite(entry.updated_at_ms) || entry.updated_at_ms < cutoff) {
        this.#entries.delete(key);
      }
    }
  }

  get(turnKey) {
    this.prune();
    return turnKey ? this.#entries.get(turnKey) ?? null : null;
  }

  set(turnKey, value) {
    if (!turnKey) return null;
    const entry = { ...value, updated_at_ms: this.now() };
    this.#entries.set(turnKey, entry);
    return entry;
  }

  status() {
    this.prune();
    return {
      active: this.#entries.size,
      ttl_seconds: this.ttlMs / 1000,
    };
  }

  async save() {
    this.prune();
    await atomicWriteJson(this.filePath, {
      version: 1,
      entries: Object.fromEntries([...this.#entries.entries()].sort(([left], [right]) => left.localeCompare(right))),
    });
  }

  async withTurnLock(turnKey, callback) {
    return this.#locks.run(turnKey || "__anonymous_turn__", callback);
  }
}
