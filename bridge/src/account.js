import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { atomicWriteJson } from "./files.js";
import { ErrorCode, NotionAgentError } from "./errors.js";

export const DEFAULT_CLIENT_VERSION = "23.13.20260528.1850";
export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
export const DEFAULT_TIMEZONE = "America/Los_Angeles";
export const DEFAULT_MODEL = "opus-4.8";

const REQUIRED_FIELDS = ["token_v2", "user_id", "space_id"];

export function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export function accountId(account) {
  return sha256(`${account.token_v2}\0${account.space_id}`).slice(0, 16);
}

export function parseBrowserCookie(value) {
  const cookies = new Map();
  for (const part of String(value ?? "").split(";")) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    cookies.set(trimmed.slice(0, separator).trim(), trimmed.slice(separator + 1));
  }
  return cookies;
}

export function normalizeAccount(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new NotionAgentError("Account data must be a JSON object.", {
      code: ErrorCode.ACCOUNT_MALFORMED,
    });
  }
  const account = { ...input };
  for (const field of REQUIRED_FIELDS) {
    if (typeof account[field] !== "string" || account[field].trim() === "") {
      throw new NotionAgentError(`Account field ${field} is required.`, {
        code: ErrorCode.ACCOUNT_INVALID,
      });
    }
  }
  account.browser_id =
    typeof account.browser_id === "string" && account.browser_id ? account.browser_id : randomUUID();
  account.device_id =
    typeof account.device_id === "string" && account.device_id ? account.device_id : randomUUID();
  account.client_version = account.client_version || DEFAULT_CLIENT_VERSION;
  account.user_agent = account.user_agent || DEFAULT_USER_AGENT;
  account.timezone = account.timezone || DEFAULT_TIMEZONE;
  account.default_model = account.default_model || DEFAULT_MODEL;
  return account;
}

export function hasJarvisBinding(account) {
  return Boolean(account?.agent_name && account?.agent_context_page_id);
}

export function cookieHeader(accountInput) {
  const account = normalizeAccount(accountInput);
  if (typeof account.full_cookie === "string" && account.full_cookie.trim()) {
    return account.full_cookie.trim();
  }
  const entries = [
    ["notion_browser_id", account.browser_id],
    ["notion_device_id", account.device_id],
    ["notion_user_id", account.user_id],
    ["notion_users", account.user_id],
    ["notion_check_cookie_consent", "false"],
    ["notion_locale", "en-US/legacy"],
    ["token_v2", account.token_v2],
  ];
  return entries.map(([name, value]) => `${name}=${value}`).join("; ");
}

export async function loadAccount(filePath) {
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new NotionAgentError("Notion account file does not exist.", {
        code: ErrorCode.ACCOUNT_MISSING,
        cause: error,
      });
    }
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new NotionAgentError("Notion account file is not valid JSON.", {
      code: ErrorCode.ACCOUNT_MALFORMED,
      cause: error,
    });
  }
  return normalizeAccount(parsed);
}

export async function saveAccount(filePath, account) {
  await atomicWriteJson(filePath, normalizeAccount(account));
}

export function defaultAccountHome() {
  return process.env.NOTION_AGENT_HOME || path.join(os.homedir(), ".notionagents");
}

export async function discoverAccountPaths(home) {
  const discovered = [];
  const primary = path.join(home, "notion_account.json");
  try {
    await readFile(primary, "utf8");
    discovered.push({ accountPath: primary, legacy: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const directory = path.join(home, "accounts");
  let names = [];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  for (const name of names.filter((value) => value.endsWith(".json")).sort()) {
    discovered.push({ accountPath: path.join(directory, name), legacy: false });
  }
  return discovered;
}
