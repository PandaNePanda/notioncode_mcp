import path from "node:path";

import {
  defaultAccountHome,
  loadAccount,
  normalizeAccount,
} from "./account.js";
import { ErrorCode, NotionAgentError } from "./errors.js";
import { loadModelAliases, modelMapPath, resolveModel } from "./models.js";
import { NDJSONStreamParser } from "./ndjson.js";
import {
  buildNotionAttachment,
  extractImageInputs,
  insertAttachmentsBeforeUser,
  uploadNotionImage,
} from "./notion-images.js";
import {
  continueThreadState,
  createThreadState,
  ThreadStateStore,
} from "./thread-state.js";
import {
  buildFullTranscript,
  buildInferenceRequest,
  buildPartialTranscript,
  currentDateTime,
  newUuid,
} from "./transcript.js";
import {
  buildNotionHeaders,
  createImpitTransport,
  invokeTransport,
  NOTION_API_BASE_URL,
} from "./transport.js";

const DEFAULT_INFERENCE_TIMEOUT_MS = 300_000;

function joinedPrompt(prompt, system) {
  const user = String(prompt ?? "");
  const instructions = String(system ?? "");
  const text = instructions ? `${instructions}\n\n${user}` : user;
  if (!text.trim()) {
    throw new NotionAgentError("Prompt must not be empty.", {
      code: ErrorCode.EMPTY_PROMPT,
    });
  }
  return text;
}

function responseStatus(response) {
  const status = Number(response?.status);
  return Number.isFinite(status) ? status : 0;
}

function responseAccepted(response) {
  const status = responseStatus(response);
  return status >= 200 && status < 300;
}

function httpError(response) {
  const status = responseStatus(response);
  if (status === 401 || status === 403) {
    return new NotionAgentError("Notion authentication was rejected.", {
      code: ErrorCode.AUTH_INVALID,
      responseStatus: status,
    });
  }
  return new NotionAgentError("Notion returned an unsuccessful response.", {
    code: ErrorCode.HTTP_ERROR,
    responseStatus: status || null,
  });
}

function transportError(error) {
  if (error instanceof NotionAgentError) return error;
  if (error?.noFailover === true && error?.code === "CLIENT_DISCONNECTED") return error;
  return new NotionAgentError("Unable to communicate with Notion.", {
    code: ErrorCode.TRANSPORT,
    cause: error,
  });
}

async function* responseTextChunks(response) {
  const body = response?.body;
  const decoder = new TextDecoder();

  if (body && typeof body[Symbol.asyncIterator] === "function") {
    for await (const chunk of body) {
      if (typeof chunk === "string") yield chunk;
      else yield decoder.decode(chunk, { stream: true });
    }
    const tail = decoder.decode();
    if (tail) yield tail;
    return;
  }

  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        yield decoder.decode(value, { stream: true });
      }
      const tail = decoder.decode();
      if (tail) yield tail;
    } finally {
      reader.releaseLock?.();
    }
    return;
  }

  if (typeof response?.text === "function") {
    yield await response.text();
    return;
  }

  throw new TypeError("Inference response does not expose a readable body.");
}

async function responseJson(response) {
  try {
    if (typeof response?.json === "function") return await response.json();
    let source = "";
    for await (const chunk of responseTextChunks(response)) source += chunk;
    return JSON.parse(source);
  } catch (error) {
    throw new NotionAgentError("Notion returned malformed JSON.", {
      code: ErrorCode.HTTP_ERROR,
      responseStatus: responseStatus(response) || null,
      cause: error,
    });
  }
}

async function closeResponse(response) {
  try {
    if (typeof response?.body?.cancel === "function") await response.body.cancel();
    else if (typeof response?.body?.destroy === "function") response.body.destroy();
  } catch {
    // Acceptance, not body consumption, defines detached-run success.
  }
}

export class NotionProvider {
  constructor(options = {}) {
    if (!options.account && !options.accountPath) {
      throw new TypeError("NotionProvider requires account or accountPath.");
    }

    this.accountPath = options.accountPath ?? null;
    this._account = options.account ? normalizeAccount(options.account) : null;
    this._accountPromise = null;
    this.baseUrl = String(options.baseUrl ?? NOTION_API_BASE_URL).replace(/\/$/, "");
    this.transport = options.transport ?? createImpitTransport();
    this.asPatchResponse = options.asPatchResponse ?? true;
    this.generateTitle = options.generateTitle ?? true;
    this.reasoningEffort = options.reasoningEffort ?? null;
    this.uuid = options.uuid ?? newUuid;
    this.now = options.now ?? (() => new Date());
    this.inferenceTimeoutMs = options.inferenceTimeoutMs ?? DEFAULT_INFERENCE_TIMEOUT_MS;
    this.imageUploadDelayMs = options.imageUploadDelayMs ?? 100;

    const home = options.accountHome
      ?? (this.accountPath ? path.dirname(this.accountPath) : defaultAccountHome());
    this.modelAliasesPath = options.modelAliasesPath ?? modelMapPath(home);
    this._modelAliases = options.modelAliases ?? null;
    this._modelAliasesPromise = null;
    this.threadStore = options.threadStore
      ?? new ThreadStateStore(options.threadStateDirectory ?? path.join(home, "threads"));
  }

  async account() {
    if (this._account) return this._account;
    this._accountPromise ??= loadAccount(this.accountPath);
    this._account = await this._accountPromise;
    return this._account;
  }

  async modelAliases() {
    if (this._modelAliases) return this._modelAliases;
    this._modelAliasesPromise ??= loadModelAliases(this.modelAliasesPath);
    this._modelAliases = await this._modelAliasesPromise;
    return this._modelAliases;
  }

  _nowDate() {
    const value = this.now();
    return value instanceof Date ? value : new Date(value);
  }

  _nowIso() {
    return this._nowDate().toISOString();
  }

  async prepare(options = {}) {
    const account = await this.account();
    const userText = joinedPrompt(options.prompt, options.system);
    const useWebSearch = options.webSearch ?? options.web_search ?? true;
    const useWorkspaceSearch = options.workspaceSearch ?? options.workspace_search ?? true;
    const useReadOnlyMode = options.askMode ?? options.ask_mode ?? false;
    const requestedModel = options.model ?? account.default_model;
    const requestedThreadId = options.threadId ?? options.thread_id ?? null;
    const explicitWorkflowId = options.workflowId ?? options.workflow_id ?? null;

    if (requestedThreadId) {
      const previousState = await this.threadStore.load(requestedThreadId);
      const workflowId = explicitWorkflowId ?? previousState.workflow_id;
      const updatedConfigId = this.uuid();
      const transcript = buildPartialTranscript(account, {
        newUserText: userText,
        notionModel: previousState.notion_model,
        reasoningEffort: this.reasoningEffort,
        configId: previousState.config_id,
        contextId: previousState.context_id,
        updatedConfigIds: [...previousState.updated_config_ids, updatedConfigId],
        useWebSearch,
        useWorkspaceSearch,
        useReadOnlyMode,
        originalDatetime: previousState.original_datetime,
        workflowId,
        now: this._nowDate(),
        uuid: this.uuid,
      });
      return {
        account,
        requestedModel,
        notionModel: previousState.notion_model,
        threadId: previousState.thread_id,
        workflowId,
        pendingState: continueThreadState(previousState, updatedConfigId, {
          now: () => this._nowIso(),
        }),
        request: buildInferenceRequest(account, {
          transcript,
          threadId: previousState.thread_id,
          createThread: false,
          isPartialTranscript: true,
          asPatchResponse: this.asPatchResponse,
          generateTitle: false,
          workflowId,
          uuid: this.uuid,
        }),
      };
    }

    const aliases = await this.modelAliases();
    const notionModel = resolveModel(requestedModel, aliases);
    const configId = this.uuid();
    const contextId = this.uuid();
    const threadId = this.uuid();
    const firstTurnDate = this._nowDate();
    const originalDatetime = currentDateTime(account.timezone, firstTurnDate);
    const transcript = buildFullTranscript(account, {
      userText,
      notionModel,
      reasoningEffort: this.reasoningEffort,
      useWebSearch,
      useWorkspaceSearch,
      useReadOnlyMode,
      configId,
      contextId,
      now: originalDatetime,
      workflowId: explicitWorkflowId,
      uuid: this.uuid,
    });
    return {
      account,
      requestedModel,
      notionModel,
      threadId,
      workflowId: explicitWorkflowId,
      pendingState: createThreadState({
        thread_id: threadId,
        config_id: configId,
        context_id: contextId,
        original_datetime: originalDatetime,
        notion_model: notionModel,
        last_activity_iso: firstTurnDate.toISOString(),
        workflow_id: explicitWorkflowId,
      }),
      request: buildInferenceRequest(account, {
        transcript,
        threadId,
        createThread: true,
        isPartialTranscript: false,
        asPatchResponse: this.asPatchResponse,
        generateTitle: this.generateTitle,
        workflowId: explicitWorkflowId,
        uuid: this.uuid,
      }),
    };
  }

  async _postInference(prepared) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.inferenceTimeoutMs);
    timer.unref?.();
    try {
      const response = await invokeTransport(
        this.transport,
        `${this.baseUrl}/runInferenceTranscript`,
        {
          method: "POST",
          headers: buildNotionHeaders(prepared.account, {
            accept: "application/x-ndjson",
            contentType: "application/json",
          }),
          body: JSON.stringify(prepared.request),
          signal: controller.signal,
          timeout: this.inferenceTimeoutMs,
        },
      );
      if (!responseAccepted(response)) throw httpError(response);
      return response;
    } catch (error) {
      throw transportError(error);
    } finally {
      clearTimeout(timer);
    }
  }

  async complete(options = {}) {
    const syncCallback = options.onTextDelta
      ?? options.textDeltaCallback
      ?? options.on_text_delta
      ?? null;
    const asyncCallback = options.onTextDeltaAsync
      ?? options.asyncTextDeltaCallback
      ?? options.on_text_delta_async
      ?? null;
    if (syncCallback && asyncCallback) {
      throw new NotionAgentError("Only one text-delta callback may be supplied.", {
        code: ErrorCode.INVALID_CALLBACK,
      });
    }

    const prepared = await this.prepare(options);
    const { images } = extractImageInputs(options.images ?? []);
    if (images.length > 0) {
      const attachments = [];
      for (const image of images) {
        const uploaded = await uploadNotionImage({
          account: prepared.account,
          threadId: prepared.threadId,
          createThread: prepared.request.createThread,
          image,
          uuid: this.uuid,
          requestUploadDescriptor: (body) => this.postJson(
            "getUploadFileUrlForAssistantChatTranscriptUpload",
            body,
          ),
          transport: this.transport,
        });
        attachments.push(buildNotionAttachment(image, uploaded));
      }
      prepared.request = {
        ...prepared.request,
        transcript: insertAttachmentsBeforeUser(prepared.request.transcript, attachments),
      };
      if (this.imageUploadDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.imageUploadDelayMs));
      }
    }
    const response = await this._postInference(prepared);
    const parser = new NDJSONStreamParser();
    let emittedText = "";

    try {
      for await (const chunk of responseTextChunks(response)) {
        parser.feed(chunk);
        if (parser.text.startsWith(emittedText) && parser.text.length > emittedText.length) {
          const delta = parser.text.slice(emittedText.length);
          emittedText = parser.text;
          if (syncCallback) syncCallback(delta);
          if (asyncCallback) await asyncCallback(delta);
        } else if (parser.text !== emittedText) {
          emittedText = parser.text;
        }
      }
      const result = parser.finalize();
      if (result.text.startsWith(emittedText) && result.text.length > emittedText.length) {
        const delta = result.text.slice(emittedText.length);
        if (syncCallback) syncCallback(delta);
        if (asyncCallback) await asyncCallback(delta);
      }
      if (!result.text) {
        throw new NotionAgentError(
          `Notion returned no text (${result.line_count} stream lines).`,
          { code: ErrorCode.EMPTY_TEXT },
        );
      }
      await this.threadStore.save(prepared.pendingState);
      return {
        text: result.text,
        model: prepared.requestedModel,
        thread_id: prepared.threadId,
        thinking: result.thinking,
        usage: {
          input_tokens: result.input_tokens,
          output_tokens: result.output_tokens,
          cache_read: result.cache_read_tokens,
          cache_creation: result.cache_creation_tokens,
        },
        raw: {
          notion_model: result.notion_model,
          event_type_counts: result.event_type_counts,
          line_count: result.line_count,
          image_count: images.length,
        },
      };
    } catch (error) {
      throw transportError(error);
    }
  }

  async *rawLines(options = {}) {
    const prepared = await this.prepare(options);
    const response = await this._postInference(prepared);
    let buffer = "";
    let fullyConsumed = false;
    try {
      for await (const chunk of responseTextChunks(response)) {
        buffer += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim()) yield line;
        }
      }
      if (buffer.trim()) yield buffer;
      fullyConsumed = true;
    } catch (error) {
      throw transportError(error);
    } finally {
      if (fullyConsumed) await this.threadStore.save(prepared.pendingState);
    }
  }

  async runDetached(options = {}) {
    const prepared = await this.prepare(options);
    const response = await this._postInference(prepared);
    await closeResponse(response);
    await this.threadStore.save(prepared.pendingState);
    return prepared.threadId;
  }

  async postJson(route, body) {
    const account = await this.account();
    let response;
    try {
      response = await invokeTransport(this.transport, `${this.baseUrl}/${route}`, {
        method: "POST",
        headers: buildNotionHeaders(account, {
          accept: "application/json",
          contentType: "application/json",
        }),
        body: JSON.stringify(body),
        timeout: this.inferenceTimeoutMs,
      });
    } catch (error) {
      throw transportError(error);
    }
    if (!responseAccepted(response)) throw httpError(response);
    return responseJson(response);
  }

  async fetchAvailableModels() {
    const account = await this.account();
    return this.postJson("getAvailableModels", { spaceId: account.space_id });
  }

  async fetchCustomAgents() {
    const account = await this.account();
    return this.postJson("getCustomAgents", { spaceId: account.space_id });
  }

  async fetchWorkflowRecords(workflowIds) {
    if (!Array.isArray(workflowIds) || workflowIds.length === 0) {
      return { recordMap: { workflow: {} } };
    }
    const account = await this.account();
    return this.postJson("syncRecordValuesMain", {
      requests: workflowIds.map((id) => ({
        pointer: { table: "workflow", id, spaceId: account.space_id },
        version: -1,
      })),
    });
  }

  async fetchWorkflowTranscripts(workflowId, options = {}) {
    const account = await this.account();
    const body = {
      workflowId,
      spaceId: account.space_id,
      limit: options.limit ?? 10,
    };
    const userId = options.userId ?? options.user_id;
    if (userId != null) body.userId = userId;
    return this.postJson("getInferenceTranscriptsForWorkflow", body);
  }

  async fetchUserTranscripts(options = {}) {
    const account = await this.account();
    return this.postJson("getInferenceTranscriptsForUser", {
      threadParentPointer: {
        table: "space",
        id: account.space_id,
        spaceId: account.space_id,
      },
      limit: options.limit ?? 50,
      includeWriterChats: options.includeWriterChats ?? options.include_writer_chats ?? false,
    });
  }

  async fetchThreadSpaceId(threadId) {
    return this.postJson("getThreadSpaceId", { threadId });
  }

  async markTranscriptSeen(threadId) {
    const account = await this.account();
    return this.postJson("markInferenceTranscriptSeen", {
      spaceId: account.space_id,
      threadId,
    });
  }

  async fetchUnreadTranscriptCount(options = {}) {
    const account = await this.account();
    return this.postJson("getInferenceTranscriptsUnreadCount", {
      spaceId: account.space_id,
      threadParentId: options.threadParentId ?? options.thread_parent_id ?? account.space_id,
    });
  }

  async fetchPausedWorkflowRuns(workflowId, options = {}) {
    const account = await this.account();
    return this.postJson("listPausedWorkflowRuns", {
      spaceId: account.space_id,
      workflowId,
      pausedReasons: options.pausedReasons ?? options.paused_reasons ?? [
        "creditLimit",
        "runLimit",
        "runawayCreditUsage",
      ],
      countOnly: options.countOnly ?? options.count_only ?? false,
    });
  }

  async syncRecord(table, recordId, options = {}) {
    const account = await this.account();
    const pointer = { table, id: recordId };
    if (options.withSpaceId ?? options.with_space_id ?? true) {
      pointer.spaceId = account.space_id;
    }
    return this.postJson("syncRecordValuesMain", {
      requests: [{ pointer, version: -1 }],
    });
  }
}
