import { stat } from "node:fs/promises";
import path from "node:path";
import {
  discoverAccountPaths,
  loadAccount,
  normalizeAccount,
  parseBrowserCookie,
  saveAccount,
  sha256,
} from "./account.js";
import { MAX_ACCOUNTS } from "./account-pool.js";
import { bootstrapAccount, bootstrapAccounts } from "./bootstrap.js";

export class InitUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "InitUsageError";
    this.exitCode = 2;
  }
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function readCredentialInput(stream) {
  let value = "";
  for await (const chunk of stream) value += chunk.toString("utf8");
  value = value.trim();
  if (!value) throw new InitUsageError("Credential input from stdin was empty.");
  return value;
}

export function parseInitCredential({ cookie = null, tokenV2 = null } = {}) {
  if (cookie && tokenV2) {
    throw new InitUsageError("Use either --cookie or --token-v2, not both.");
  }
  if (cookie !== null) {
    const fullCookie = String(cookie).trim();
    if (!fullCookie) throw new InitUsageError("The supplied browser cookie was empty.");
    const parsed = parseBrowserCookie(fullCookie);
    const token = parsed.get("token_v2");
    if (!token) {
      throw new InitUsageError(
        "--cookie requires a complete browser cookie containing token_v2; use --token-v2 for a bare token.",
      );
    }
    return {
      tokenV2: token,
      fullCookie,
      userId: parsed.get("notion_user_id") || null,
      browserId: parsed.get("notion_browser_id") || null,
    };
  }
  if (tokenV2 !== null) {
    const token = String(tokenV2).trim();
    if (!token) throw new InitUsageError("The supplied token_v2 was empty.");
    if (parseBrowserCookie(token).has("token_v2")) {
      throw new InitUsageError("--token-v2 requires a bare token; use --cookie for a complete browser cookie.");
    }
    return { tokenV2: token, fullCookie: null, userId: null, browserId: null };
  }
  throw new InitUsageError("A credential is required through --cookie or --token-v2.");
}

export async function resolveInitCredential({ cookie = null, tokenV2 = null, stdin }) {
  if (cookie !== null && tokenV2 !== null) {
    throw new InitUsageError("Use either --cookie or --token-v2, not both.");
  }
  const cookieValue = cookie === "-" ? await readCredentialInput(stdin) : cookie;
  const tokenValue = tokenV2 === "-" ? await readCredentialInput(stdin) : tokenV2;
  return parseInitCredential({ cookie: cookieValue, tokenV2: tokenValue });
}

export function safeAccountSummary(account, accountPath) {
  return {
    account_file: path.resolve(accountPath),
    user_id: account.user_id,
    user_name: account.user_name || "",
    user_email: account.user_email || "",
    workspace_id: account.space_id,
    workspace_name: account.space_name || "",
    workspace_domain: account.space_domain || "",
    agent_name: account.agent_name || null,
    agent_bound: Boolean(account.agent_name && account.agent_context_page_id),
  };
}

export function workspaceSelectionHelp(error) {
  const workspaces = Array.isArray(error?.workspaces) ? error.workspaces : [];
  return workspaces.map((workspace) => ({
    name: workspace.space_name || "",
    domain: workspace.domain || "",
    id: workspace.space_id || "",
  }));
}

export async function enrichAgentBinding(
  account,
  {
    agentName = null,
    agentContextPageId = null,
    lookupAgentByPageId = null,
    warn = () => {},
    inform = () => {},
  } = {},
) {
  if (!agentContextPageId) {
    if (agentName) {
      warn(
        `--agent-name ${JSON.stringify(agentName)} was given without --agent-page-id; ` +
          "no custom-agent binding will be created.",
      );
    }
    return normalizeAccount(account);
  }

  if (typeof lookupAgentByPageId !== "function") return normalizeAccount(account);

  let match;
  try {
    match = await lookupAgentByPageId(account, agentContextPageId);
  } catch {
    return normalizeAccount(account);
  }

  if (match?.name) {
    inform(
      `page_id matched registered Custom Agent: ${JSON.stringify(match.name)} ` +
        "(binding_mode: persona_overlay)",
    );
    return normalizeAccount({
      ...account,
      agent_name: agentName || match.name,
      agent_binding_mode: "persona_overlay",
    });
  }

  if (!agentName) {
    warn(
      `--agent-page-id ${agentContextPageId} was not found in the Custom Agents list; ` +
        "pass --agent-name to bind it as a free-form steering page.",
    );
    return normalizeAccount(account);
  }

  inform(
    `page_id not in Custom Agents list; binding ${JSON.stringify(agentName)} ` +
      "as a free-form steering page (binding_mode: free_form_steering)",
  );
  return normalizeAccount({ ...account, agent_binding_mode: "free_form_steering" });
}

export async function initializeAccount({
  accountPath,
  credential,
  force = false,
  spaceDomain = null,
  spaceName = null,
  timezone,
  agentName = null,
  agentAccessory = null,
  agentContextPageId = null,
  defaultModel,
  transport,
  enrichAccount = null,
}) {
  if (!accountPath) throw new InitUsageError("An account output path is required.");
  if (!force && (await exists(accountPath))) {
    throw new InitUsageError("The account file already exists; pass --force to replace it.");
  }
  let account = await bootstrapAccount({
    tokenV2: credential.tokenV2,
    userId: credential.userId,
    browserId: credential.browserId || undefined,
    spaceDomain,
    spaceName,
    timezone,
    agentName,
    agentAccessory,
    agentContextPageId,
    defaultModel,
    transport,
  });
  if (credential.fullCookie) account.full_cookie = credential.fullCookie;
  if (typeof enrichAccount === "function") account = await enrichAccount(account);
  await saveAccount(accountPath, account);
  return { account, summary: safeAccountSummary(account, accountPath) };
}

async function nextAccountPath(accountHome, reserved) {
  const primary = path.join(accountHome, "notion_account.json");
  if (!reserved.has(path.resolve(primary)) && !(await exists(primary))) {
    reserved.add(path.resolve(primary));
    return primary;
  }
  for (let index = 2; ; index += 1) {
    const candidate = path.join(accountHome, "accounts", `account-${String(index).padStart(2, "0")}.json`);
    const resolved = path.resolve(candidate);
    if (reserved.has(resolved) || (await exists(candidate))) continue;
    reserved.add(resolved);
    return candidate;
  }
}

export async function initializeAllWorkspaces({
  accountHome,
  credential,
  timezone,
  agentName = null,
  agentAccessory = null,
  agentContextPageId = null,
  defaultModel,
  transport,
  enrichAccount = null,
}) {
  if (!accountHome) throw new InitUsageError("An account home is required.");
  const candidates = await bootstrapAccounts({
    tokenV2: credential.tokenV2,
    userId: credential.userId,
    browserId: credential.browserId || undefined,
    timezone,
    agentName,
    agentAccessory,
    agentContextPageId,
    defaultModel,
    transport,
  });
  const discovered = await discoverAccountPaths(accountHome);
  const reserved = new Set(discovered.map(({ accountPath }) => path.resolve(accountPath)));
  const existing = new Map();
  for (const { accountPath } of discovered) {
    try {
      const account = await loadAccount(accountPath);
      existing.set(sha256(`${account.token_v2}\0${account.space_id}`), accountPath);
    } catch {
      // Invalid legacy files remain untouched for the migration command.
    }
  }

  const pendingFingerprints = new Set(
    candidates
      .map((account) => sha256(`${account.token_v2}\0${account.space_id}`))
      .filter((fingerprint) => !existing.has(fingerprint)),
  );
  if (existing.size + pendingFingerprints.size > MAX_ACCOUNTS) {
    throw new InitUsageError(
      `At most ${MAX_ACCOUNTS} unique Notion accounts are supported; ` +
        `${existing.size} already exist and ${pendingFingerprints.size} new workspaces were discovered.`,
    );
  }

  const created = [];
  const skipped = [];
  for (let account of candidates) {
    const fingerprint = sha256(`${account.token_v2}\0${account.space_id}`);
    const duplicatePath = existing.get(fingerprint);
    if (duplicatePath) {
      skipped.push({
        account_file: path.resolve(duplicatePath),
        workspace_id: account.space_id,
        workspace_name: account.space_name || "",
      });
      continue;
    }
    if (credential.fullCookie) account.full_cookie = credential.fullCookie;
    if (typeof enrichAccount === "function") account = await enrichAccount(account);
    const accountPath = await nextAccountPath(accountHome, reserved);
    await saveAccount(accountPath, account);
    existing.set(fingerprint, accountPath);
    created.push({ account, summary: safeAccountSummary(account, accountPath) });
  }
  return { created, skipped, discovered_workspaces: candidates.length };
}
