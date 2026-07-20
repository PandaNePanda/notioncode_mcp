import { readFile } from "node:fs/promises";
import { atomicWriteJson } from "./files.js";
import { fingerprint, KeyedMutex } from "./state.js";

export const CONVERSATION_SEGMENT_VERSION = 1;
export const CONVERSATION_SEGMENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_CONVERSATIONS = 500;

export function conversationIdentity(value) {
  return fingerprint(value);
}

export function itemFingerprints(items) {
  return (Array.isArray(items) ? items : []).map((item) => fingerprint(item));
}

export function appendOnlyPrefix(previous, current) {
  if (!Array.isArray(previous) || !Array.isArray(current) || current.length < previous.length) return null;
  for (let index = 0; index < previous.length; index += 1) {
    if (previous[index] !== current[index]) return null;
  }
  return previous.length;
}

export class ConversationSegmentStore {
  #conversations = new Map();
  #locks = new KeyedMutex();

  constructor(
    filePath,
    {
      ttlMs = CONVERSATION_SEGMENT_TTL_MS,
      maximum = MAX_CONVERSATIONS,
      now = () => Date.now(),
    } = {},
  ) {
    this.filePath = filePath;
    this.ttlMs = ttlMs;
    this.maximum = maximum;
    this.now = now;
  }

  async load() {
    let parsed;
    try {
      parsed = JSON.parse(await readFile(this.filePath, "utf8"));
    } catch {
      this.#conversations.clear();
      return;
    }
    this.#conversations.clear();
    if (
      parsed?.version !== CONVERSATION_SEGMENT_VERSION ||
      !parsed.conversations ||
      typeof parsed.conversations !== "object"
    ) {
      return;
    }
    for (const [identity, segment] of Object.entries(parsed.conversations)) {
      if (segment && typeof segment === "object") this.#conversations.set(identity, segment);
    }
    this.prune();
  }

  prune() {
    const cutoff = this.now() - this.ttlMs;
    for (const [identity, segment] of this.#conversations) {
      if (!Number.isFinite(segment.updated_at_ms) || segment.updated_at_ms < cutoff) {
        this.#conversations.delete(identity);
      }
    }
    const newest = [...this.#conversations.entries()].sort(
      ([, left], [, right]) => (right.updated_at_ms ?? 0) - (left.updated_at_ms ?? 0),
    );
    for (const [identity] of newest.slice(this.maximum)) this.#conversations.delete(identity);
  }

  get(conversationKey) {
    this.prune();
    return this.#conversations.get(conversationIdentity(conversationKey)) ?? null;
  }

  inspect(conversationKey, items) {
    const segment = this.get(conversationKey);
    const current = itemFingerprints(items);
    return {
      segment,
      fingerprints: current,
      prefixLength: segment ? appendOnlyPrefix(segment.item_fingerprints, current) : 0,
    };
  }

  set(conversationKey, value) {
    const identity = conversationIdentity(conversationKey);
    const previous = this.#conversations.get(identity);
    const segment = {
      segment_index: previous?.segment_index ?? 0,
      account_id: null,
      notion_thread_id: null,
      item_fingerprints: [],
      awaiting_compacted_history: false,
      turns: 0,
      input_tokens: 0,
      output_tokens: 0,
      ...previous,
      ...value,
      updated_at_ms: this.now(),
    };
    this.#conversations.set(identity, segment);
    this.prune();
    return segment;
  }

  startFreshSegment(conversationKey, value = {}) {
    const previous = this.get(conversationKey);
    return this.set(conversationKey, {
      segment_index: (previous?.segment_index ?? -1) + 1,
      account_id: null,
      notion_thread_id: null,
      item_fingerprints: [],
      awaiting_compacted_history: false,
      turns: 0,
      input_tokens: 0,
      output_tokens: 0,
      ...value,
    });
  }

  markAwaitingCompactedHistory(conversationKey) {
    return this.set(conversationKey, { awaiting_compacted_history: true });
  }

  status() {
    this.prune();
    return {
      active: this.#conversations.size,
      ttl_seconds: this.ttlMs / 1000,
      maximum: this.maximum,
      persistent: Boolean(this.filePath),
    };
  }

  async save() {
    this.prune();
    await atomicWriteJson(this.filePath, {
      version: CONVERSATION_SEGMENT_VERSION,
      conversations: Object.fromEntries(
        [...this.#conversations.entries()].sort(([left], [right]) => left.localeCompare(right)),
      ),
    });
  }

  async withConversationLock(conversationKey, callback) {
    return this.#locks.run(conversationIdentity(conversationKey), callback);
  }
}
