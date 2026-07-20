import { cookieHeader, loadAccount, saveAccount } from "./account.js";
import { fetchSessionWarmup } from "./transport.js";

export const CLIENT_VERSION_TTL_MS = 24 * 60 * 60 * 1000;
export const CLOUDFLARE_COOKIE_TTL_MS = 25 * 60 * 1000;
export const REFRESHABLE_COOKIE_NAMES = Object.freeze(["__cf_bm", "_cfuvid", "token_v2"]);

function timestampMs(value) {
  if (typeof value !== "string" || value.trim() === "") return Number.NaN;
  const normalized = /(?:Z|[+-]\d\d:\d\d)$/i.test(value) ? value : `${value}Z`;
  return Date.parse(normalized);
}

export function isFresh(value, ttlMs, now = new Date()) {
  const then = timestampMs(value);
  const current = now instanceof Date ? now.getTime() : new Date(now).getTime();
  return Number.isFinite(then) && Number.isFinite(current) && current - then < ttlMs;
}

export function mergeCookieHeader(cookie, updates) {
  const entries = [];
  const positions = new Map();
  for (const part of String(cookie ?? "").split(";")) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const name = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1);
    if (positions.has(name)) {
      entries[positions.get(name)][1] = value;
    } else {
      positions.set(name, entries.length);
      entries.push([name, value]);
    }
  }
  for (const [name, value] of Object.entries(updates ?? {})) {
    if (positions.has(name)) {
      entries[positions.get(name)][1] = String(value);
    } else {
      positions.set(name, entries.length);
      entries.push([name, String(value)]);
    }
  }
  return entries.map(([name, value]) => `${name}=${value}`).join("; ");
}

function hasCloudflareCookie(cookie) {
  return /(?:^|;\s*)__cf_bm=/.test(String(cookie ?? ""));
}

export async function refreshSession({
  accountPath,
  transport,
  now = new Date(),
  load = loadAccount,
  save = saveAccount,
  warmup = fetchSessionWarmup,
} = {}) {
  let account;
  try {
    account = await load(accountPath);
  } catch {
    return { account: null, refreshed: false, skipped: true, reason: "account_unavailable" };
  }

  const outgoingCookie = cookieHeader(account);
  const clientVersionFresh = isFresh(
    account.client_version_refreshed_at,
    CLIENT_VERSION_TTL_MS,
    now,
  );
  const cloudflareFresh =
    hasCloudflareCookie(outgoingCookie) &&
    isFresh(account.cf_refreshed_at, CLOUDFLARE_COOKIE_TTL_MS, now);
  if (clientVersionFresh && cloudflareFresh) {
    return { account, refreshed: false, skipped: true, reason: "fresh" };
  }

  let result;
  try {
    result = await warmup({ account, transport });
  } catch {
    return { account, refreshed: false, skipped: false, reason: "offline" };
  }

  const updated = { ...account };
  const nowIso = (now instanceof Date ? now : new Date(now)).toISOString();
  if (typeof result?.clientVersion === "string" && result.clientVersion) {
    updated.client_version = result.clientVersion;
    updated.client_version_refreshed_at = nowIso;
  }

  const allowedCookies = {};
  for (const name of REFRESHABLE_COOKIE_NAMES) {
    if (Object.hasOwn(result?.cookies ?? {}, name)) allowedCookies[name] = result.cookies[name];
  }
  if (Object.keys(allowedCookies).length > 0) {
    updated.full_cookie = mergeCookieHeader(outgoingCookie, allowedCookies);
  }

  const mergedCookie = updated.full_cookie ?? outgoingCookie;
  if (hasCloudflareCookie(outgoingCookie) || hasCloudflareCookie(mergedCookie)) {
    updated.cf_refreshed_at = nowIso;
  }

  const changed = JSON.stringify(updated) !== JSON.stringify(account);
  if (changed) await save(accountPath, updated);
  return {
    account: updated,
    refreshed: changed,
    skipped: false,
    reason: changed ? "updated" : "unchanged",
  };
}
