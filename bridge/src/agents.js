import { unwrapRecord } from "./bootstrap.js";
import { ErrorCode, NotionAgentError } from "./errors.js";
import {
  buildNotionHeaders,
  createImpitTransport,
  invokeTransport,
  NOTION_API_BASE_URL,
} from "./transport.js";

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function trimmedString(value) {
  if (typeof value !== "string") return null;
  const result = value.trim();
  return result || null;
}

function toInteger(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value !== "string" || !/^[+-]?\d+$/.test(value.trim())) return null;
  const result = Number(value);
  return Number.isSafeInteger(result) ? result : null;
}

function workflowData(workflowValue) {
  return isObject(workflowValue?.data) ? workflowValue.data : null;
}

export function extractWorkflowName(workflowValue) {
  return trimmedString(workflowData(workflowValue)?.name);
}

export function extractWorkflowIcon(workflowValue) {
  return trimmedString(workflowData(workflowValue)?.icon);
}

export function extractWorkflowDescription(workflowValue) {
  return trimmedString(workflowData(workflowValue)?.description);
}

export function extractWorkflowInstructionsPageId(workflowValue) {
  const instructions = workflowData(workflowValue)?.instructions;
  return isObject(instructions) ? trimmedString(instructions.id) : null;
}

export function parseWorkflowRecords(syncResponse) {
  const records = syncResponse?.recordMap?.workflow;
  if (!isObject(records)) return {};
  const result = {};
  for (const [workflowId, record] of Object.entries(records)) {
    if (!isObject(record?.value)) continue;
    const value = isObject(record.value.value) ? record.value.value : record.value;
    result[workflowId] = value;
  }
  return result;
}

export function parseThreads(response) {
  const result = [];
  for (const entry of response?.mostRecentTranscripts ?? []) {
    if (!isObject(entry) || typeof entry.id !== "string") continue;
    result.push({
      thread_id: entry.id,
      title: typeof entry.title === "string" ? entry.title : null,
      parent_agent_id: typeof entry.parent_id === "string" ? entry.parent_id : null,
      created_at_ms: toInteger(entry.created_time),
      updated_at_ms: toInteger(entry.updated_time),
      created_by_id: typeof entry.created_by_id === "string" ? entry.created_by_id : null,
      created_source: typeof entry.created_source === "string" ? entry.created_source : null,
    });
  }
  result.sort((left, right) => {
    const leftTime = Math.max(left.updated_at_ms ?? 0, left.created_at_ms ?? 0);
    const rightTime = Math.max(right.updated_at_ms ?? 0, right.created_at_ms ?? 0);
    return rightTime - leftTime || left.thread_id.localeCompare(right.thread_id);
  });
  return result;
}

export function parseAgents(response, { workflows = {} } = {}) {
  const activity = new Map();
  for (const entry of response?.activityScores ?? []) {
    const score = toInteger(entry?.activity_score);
    if (typeof entry?.parent_id !== "string" || score === null) continue;
    const previous = activity.get(entry.parent_id);
    if (previous === undefined || score > previous) activity.set(entry.parent_id, score);
  }

  const recentByAgent = new Map();
  for (const thread of parseThreads(response)) {
    if (thread.parent_agent_id && !recentByAgent.has(thread.parent_agent_id)) {
      recentByAgent.set(thread.parent_agent_id, thread);
    }
  }

  const result = [];
  for (const agentId of response?.agentIds ?? []) {
    if (typeof agentId !== "string") continue;
    const workflow = isObject(workflows[agentId]) ? workflows[agentId] : {};
    const recent = recentByAgent.get(agentId);
    result.push({
      agent_id: agentId,
      activity_score: activity.get(agentId) ?? null,
      most_recent_thread_id: recent?.thread_id ?? null,
      most_recent_thread_title: recent?.title ?? null,
      name: extractWorkflowName(workflow),
      icon: extractWorkflowIcon(workflow),
      description: extractWorkflowDescription(workflow),
      agent_page_id: extractWorkflowInstructionsPageId(workflow),
    });
  }
  result.sort(
    (left, right) =>
      (right.activity_score ?? 0) - (left.activity_score ?? 0) ||
      left.agent_id.localeCompare(right.agent_id),
  );
  return result;
}

export async function postNotionJson({
  account,
  path,
  body,
  transport = createImpitTransport(),
  apiBaseUrl = NOTION_API_BASE_URL,
}) {
  let response;
  try {
    response = await invokeTransport(transport, `${apiBaseUrl}/${path}`, {
      method: "POST",
      headers: buildNotionHeaders(account, { accept: "application/json" }),
      body: JSON.stringify(body),
      timeout: 20_000,
    });
  } catch (error) {
    if (error instanceof NotionAgentError) throw error;
    throw new NotionAgentError(`Unable to reach Notion for ${path}.`, {
      code: ErrorCode.TRANSPORT,
      cause: error,
    });
  }
  if (response.status === 401 || response.status === 403) {
    throw new NotionAgentError("Notion rejected the account credential.", {
      code: ErrorCode.AUTH_INVALID,
      responseStatus: response.status,
    });
  }
  if (response.status !== 200) {
    throw new NotionAgentError(`Notion returned an unsuccessful ${path} response.`, {
      code: ErrorCode.HTTP_ERROR,
      responseStatus: response.status,
    });
  }
  try {
    const payload = await response.json();
    if (!isObject(payload)) throw new TypeError("JSON response was not an object");
    return payload;
  } catch (error) {
    throw new NotionAgentError(`Notion returned malformed ${path} data.`, {
      code: ErrorCode.NOTION_ERROR,
      responseStatus: response.status,
      cause: error,
    });
  }
}

export function fetchCustomAgents(account, options = {}) {
  return postNotionJson({
    ...options,
    account,
    path: "getCustomAgents",
    body: { spaceId: account.space_id },
  });
}

export function fetchWorkflowRecords(account, workflowIds, options = {}) {
  if (workflowIds.length === 0) return Promise.resolve({ recordMap: { workflow: {} } });
  return postNotionJson({
    ...options,
    account,
    path: "syncRecordValuesMain",
    body: {
      requests: workflowIds.map((workflowId) => ({
        pointer: { table: "workflow", id: workflowId, spaceId: account.space_id },
        version: -1,
      })),
    },
  });
}

export async function lookupRegisteredAgentByPageId(
  account,
  pageId,
  { transport = createImpitTransport(), apiBaseUrl = NOTION_API_BASE_URL } = {},
) {
  const customAgents = await fetchCustomAgents(account, { transport, apiBaseUrl });
  const workflowIds = (customAgents.agentIds ?? []).filter((value) => typeof value === "string");
  const rawWorkflows = await fetchWorkflowRecords(account, workflowIds, {
    transport,
    apiBaseUrl,
  });
  const workflows = parseWorkflowRecords(rawWorkflows);
  return (
    parseAgents(customAgents, { workflows }).find((agent) => agent.agent_page_id === pageId) ?? null
  );
}
