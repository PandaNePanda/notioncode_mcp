import { randomUUID } from "node:crypto";
import {
  DEFAULT_CLIENT_VERSION,
  DEFAULT_MODEL,
  DEFAULT_TIMEZONE,
  DEFAULT_USER_AGENT,
  normalizeAccount,
} from "./account.js";
import { AmbiguousWorkspaceError, ErrorCode, NotionAgentError } from "./errors.js";

export const NOTION_ORIGIN = "https://" + "www.notion.so";
export const LOAD_USER_CONTENT_URL = `${NOTION_ORIGIN}/api/v3/loadUserContent`;

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function unwrapRecord(input) {
  let current = input;
  for (let depth = 0; depth < 3 && isObject(current?.value); depth += 1) {
    const keys = Object.keys(current);
    const isEnvelope =
      Object.hasOwn(current, "role") ||
      keys.length === 1 ||
      keys.every((key) => key === "role" || key === "value");
    if (!isEnvelope) break;
    current = current.value;
  }
  return isObject(current) ? current : null;
}

export function bootstrapCookie({ tokenV2, userId, browserId }) {
  const entries = [["notion_browser_id", browserId]];
  if (userId) {
    entries.push(["notion_user_id", userId]);
    entries.push(["notion_users", `[%22${userId}%22]`]);
  }
  entries.push(["notion_check_cookie_consent", "false"]);
  entries.push(["notion_locale", "en-US/legacy"]);
  entries.push(["token_v2", tokenV2]);
  return entries.map(([name, value]) => `${name}=${value}`).join("; ");
}

export function bootstrapHeaders({
  tokenV2,
  userId,
  browserId,
  clientVersion = DEFAULT_CLIENT_VERSION,
  userAgent = DEFAULT_USER_AGENT,
}) {
  const headers = {
    accept: "application/json",
    "accept-language": "en-US,en;q=0.9",
    "content-type": "application/json",
    "notion-audit-log-platform": "web",
    "notion-client-version": clientVersion,
    origin: NOTION_ORIGIN,
    referer: `${NOTION_ORIGIN}/`,
    "user-agent": userAgent,
    "sec-ch-ua": '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    cookie: bootstrapCookie({ tokenV2, userId, browserId }),
  };
  if (userId) headers["x-notion-active-user-header"] = userId;
  return headers;
}

async function invokeTransport(transport, url, options) {
  if (typeof transport === "function") return transport(url, options);
  if (transport && typeof transport.fetch === "function") return transport.fetch(url, options);
  throw new TypeError("Bootstrap transport must be a function or expose fetch().");
}

export async function fetchUserContent({
  tokenV2,
  userId = null,
  browserId = randomUUID(),
  clientVersion = DEFAULT_CLIENT_VERSION,
  userAgent = DEFAULT_USER_AGENT,
  transport = globalThis.fetch,
}) {
  let response;
  try {
    response = await invokeTransport(transport, LOAD_USER_CONTENT_URL, {
      method: "POST",
      headers: bootstrapHeaders({ tokenV2, userId, browserId, clientVersion, userAgent }),
      body: "{}",
    });
  } catch (error) {
    if (error instanceof NotionAgentError) throw error;
    throw new NotionAgentError("Unable to reach Notion while loading account metadata.", {
      code: ErrorCode.TRANSPORT,
      cause: error,
    });
  }

  if (response.status === 401 || response.status === 403) {
    throw new NotionAgentError("Notion rejected the supplied account credential.", {
      code: ErrorCode.AUTH_INVALID,
      responseStatus: response.status,
    });
  }
  if (response.status !== 200) {
    throw new NotionAgentError("Notion returned an unsuccessful account-bootstrap response.", {
      code: ErrorCode.HTTP_ERROR,
      responseStatus: response.status,
    });
  }

  try {
    return await response.json();
  } catch (error) {
    throw new NotionAgentError("Notion returned malformed account-bootstrap data.", {
      code: ErrorCode.NOTION_ERROR,
      responseStatus: response.status,
      cause: error,
    });
  }
}

function tableEntries(payload, tableName) {
  const table = payload?.recordMap?.[tableName];
  return isObject(table) ? Object.entries(table) : [];
}

export function extractUser(payload) {
  const first = tableEntries(payload, "notion_user")[0];
  if (!first) {
    throw new NotionAgentError("Notion account metadata contains no user record.", {
      code: ErrorCode.AUTH_INVALID,
    });
  }
  const [recordId, envelope] = first;
  const value = unwrapRecord(envelope);
  if (!value) {
    throw new NotionAgentError("Notion account metadata contains an invalid user record.", {
      code: ErrorCode.AUTH_INVALID,
    });
  }
  const userId = value.id || recordId;
  const combinedName = [value.given_name, value.family_name].filter(Boolean).join(" ").trim();
  return {
    user_id: userId,
    user_name: combinedName || value.name || "",
    user_email: value.email || "",
  };
}

export function extractWorkspaces(payload) {
  const viewBySpace = new Map();
  for (const [recordId, envelope] of tableEntries(payload, "space_view")) {
    const value = unwrapRecord(envelope);
    if (value?.space_id && !viewBySpace.has(value.space_id)) {
      viewBySpace.set(value.space_id, value.id || recordId);
    }
  }

  const workspaces = [];
  for (const [recordId, envelope] of tableEntries(payload, "space")) {
    const value = unwrapRecord(envelope);
    if (!value) continue;
    const spaceId = value.id || recordId;
    if (!spaceId) continue;
    workspaces.push({
      space_id: spaceId,
      space_view_id: viewBySpace.get(spaceId) || null,
      space_name: value.name || "",
      domain: value.domain || "",
    });
  }

  if (workspaces.length === 0) {
    throw new NotionAgentError("No Notion workspaces are available for this account.", {
      code: ErrorCode.WORKSPACE_EMPTY,
    });
  }
  return workspaces;
}

export function selectWorkspace(workspaces, { spaceDomain, spaceName } = {}) {
  if (workspaces.length === 1) return workspaces[0];

  let matches = [];
  if (spaceDomain) {
    matches = workspaces.filter((workspace) => workspace.domain === spaceDomain);
  } else if (spaceName) {
    const expected = spaceName.toLocaleLowerCase();
    matches = workspaces.filter(
      (workspace) => String(workspace.space_name).toLocaleLowerCase() === expected,
    );
  }
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    const names = new Set(matches.map((workspace) => workspace.space_name || ""));
    const domains = new Set(matches.map((workspace) => workspace.domain || ""));
    if (names.size === 1 && domains.size === 1) return matches[0];
  }
  throw new AmbiguousWorkspaceError(workspaces);
}

function accountFromBootstrapMetadata({
  tokenV2,
  requestedUserId,
  user,
  workspace,
  browserId,
  timezone,
  agentName,
  agentAccessory,
  agentContextPageId,
  defaultModel,
  clientVersion,
  userAgent,
}) {
  return normalizeAccount({
    token_v2: tokenV2,
    user_id: requestedUserId || user.user_id,
    user_name: user.user_name,
    user_email: user.user_email,
    space_id: workspace.space_id,
    space_view_id: workspace.space_view_id,
    space_name: workspace.space_name,
    space_domain: workspace.domain,
    browser_id: browserId,
    device_id: randomUUID(),
    timezone,
    agent_name: agentName,
    agent_accessory: agentAccessory,
    agent_context_page_id: agentContextPageId,
    default_model: defaultModel,
    client_version: clientVersion,
    user_agent: userAgent,
  });
}

export async function bootstrapAccounts({
  tokenV2,
  userId = null,
  browserId = randomUUID(),
  timezone = DEFAULT_TIMEZONE,
  agentName = null,
  agentAccessory = null,
  agentContextPageId = null,
  defaultModel = DEFAULT_MODEL,
  clientVersion = DEFAULT_CLIENT_VERSION,
  userAgent = DEFAULT_USER_AGENT,
  transport = globalThis.fetch,
}) {
  const payload = await fetchUserContent({
    tokenV2,
    userId,
    browserId,
    clientVersion,
    userAgent,
    transport,
  });
  const user = extractUser(payload);
  return extractWorkspaces(payload).map((workspace) => accountFromBootstrapMetadata({
    tokenV2,
    requestedUserId: userId,
    user,
    workspace,
    browserId,
    timezone,
    agentName,
    agentAccessory,
    agentContextPageId,
    defaultModel,
    clientVersion,
    userAgent,
  }));
}

export async function bootstrapAccount({
  tokenV2,
  userId = null,
  browserId = randomUUID(),
  spaceDomain = null,
  spaceName = null,
  timezone = DEFAULT_TIMEZONE,
  agentName = null,
  agentAccessory = null,
  agentContextPageId = null,
  defaultModel = DEFAULT_MODEL,
  clientVersion = DEFAULT_CLIENT_VERSION,
  userAgent = DEFAULT_USER_AGENT,
  transport = globalThis.fetch,
}) {
  const payload = await fetchUserContent({
    tokenV2,
    userId,
    browserId,
    clientVersion,
    userAgent,
    transport,
  });
  const user = extractUser(payload);
  const workspace = selectWorkspace(extractWorkspaces(payload), { spaceDomain, spaceName });
  return accountFromBootstrapMetadata({
    tokenV2,
    requestedUserId: userId,
    user,
    workspace,
    browserId,
    timezone,
    agentName,
    agentAccessory,
    agentContextPageId,
    defaultModel,
    clientVersion,
    userAgent,
  });
}
