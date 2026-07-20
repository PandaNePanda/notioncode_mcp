import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson } from "./files.js";
import { ErrorCode, NotionAgentError } from "./errors.js";

const THREAD_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function malformed(message, cause) {
  return new NotionAgentError(message, {
    code: ErrorCode.THREAD_STATE_MALFORMED,
    cause,
  });
}

function requiredString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw malformed(`Thread state field ${field} is required.`);
  }
  return value;
}

export function normalizeThreadState(input, options = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw malformed("Thread state must be a JSON object.");
  }
  const state = {
    ...input,
    thread_id: requiredString(input.thread_id, "thread_id"),
    config_id: requiredString(input.config_id, "config_id"),
    context_id: requiredString(input.context_id, "context_id"),
    original_datetime: requiredString(input.original_datetime, "original_datetime"),
    notion_model: requiredString(input.notion_model, "notion_model"),
    updated_config_ids: input.updated_config_ids ?? [],
    last_activity_iso: input.last_activity_iso ?? null,
    workflow_id: input.workflow_id ?? null,
  };
  if (!Array.isArray(state.updated_config_ids) || state.updated_config_ids.some((id) => typeof id !== "string" || !id)) {
    throw malformed("Thread state field updated_config_ids must be an array of non-empty strings.");
  }
  if (state.last_activity_iso !== null && typeof state.last_activity_iso !== "string") {
    throw malformed("Thread state field last_activity_iso must be a string or null.");
  }
  if (state.workflow_id !== null && (typeof state.workflow_id !== "string" || !state.workflow_id)) {
    throw malformed("Thread state field workflow_id must be a non-empty string or null.");
  }
  if (options.expectedThreadId && state.thread_id !== options.expectedThreadId) {
    throw malformed("Thread state ID does not match its filename.");
  }
  return state;
}

export function createThreadState(input, options = {}) {
  const now = options.now ?? (() => new Date().toISOString());
  return normalizeThreadState({
    thread_id: input.thread_id,
    config_id: input.config_id,
    context_id: input.context_id,
    original_datetime: input.original_datetime ?? now(),
    notion_model: input.notion_model,
    updated_config_ids: [],
    last_activity_iso: input.last_activity_iso ?? now(),
    workflow_id: input.workflow_id ?? null,
  });
}

export function continueThreadState(input, updatedConfigId, options = {}) {
  const now = options.now ?? (() => new Date().toISOString());
  const state = normalizeThreadState(input);
  const updateId = requiredString(updatedConfigId, "updated_config_id");
  return normalizeThreadState({
    ...state,
    updated_config_ids: [...state.updated_config_ids, updateId],
    last_activity_iso: now(),
  });
}

export class ThreadStateStore {
  constructor(directory) {
    this.directory = directory;
  }

  filePath(threadId) {
    if (typeof threadId !== "string" || !THREAD_ID_PATTERN.test(threadId)) {
      throw malformed("Thread ID contains unsupported characters.");
    }
    return path.join(this.directory, `${threadId}.json`);
  }

  async load(threadId) {
    const file = this.filePath(threadId);
    let parsed;
    try {
      parsed = JSON.parse(await readFile(file, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new NotionAgentError("Thread state does not exist.", {
          code: ErrorCode.THREAD_STATE_MISSING,
          cause: error,
        });
      }
      if (error instanceof SyntaxError) throw malformed("Thread state is not valid JSON.", error);
      throw error;
    }
    return normalizeThreadState(parsed, { expectedThreadId: threadId });
  }

  async save(input) {
    const state = normalizeThreadState(input);
    await atomicWriteJson(this.filePath(state.thread_id), state);
    return state;
  }

  async remove(threadId) {
    await rm(this.filePath(threadId), { force: true });
  }
}
