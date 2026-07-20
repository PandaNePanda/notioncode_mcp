import impitPackage from "impit";
import { cookieHeader } from "./account.js";
import { ErrorCode, NotionAgentError } from "./errors.js";

const { Impit } = impitPackage;

export const NOTION_APP_ORIGIN = "https://" + "app.notion.com";
export const NOTION_API_BASE_URL = `${NOTION_APP_ORIGIN}/api/v3`;
export const NOTION_WEB_BASE_URL = NOTION_APP_ORIGIN;
export const SHELL_TIMEOUT_MS = 20_000;

export function secChUa(userAgent = "") {
  const major = /Chrome\/(\d+)/.exec(String(userAgent))?.[1] ?? "148";
  return `"Chromium";v="${major}", "Google Chrome";v="${major}", "Not/A)Brand";v="99"`;
}

export function buildNotionHeaders(account, options = {}) {
  const headers = {
    accept: options.accept ?? "application/json",
    "accept-language": "en-US,en;q=0.9",
    "content-type": options.contentType ?? "application/json",
    "notion-audit-log-platform": "web",
    "notion-client-version": account.client_version,
    origin: NOTION_APP_ORIGIN,
    referer: `${NOTION_WEB_BASE_URL}/ai?assetsVersion=${account.client_version}`,
    "user-agent": account.user_agent,
    "x-notion-active-user-header": account.user_id,
    "x-notion-space-id": account.space_id,
    "sec-ch-ua": secChUa(account.user_agent),
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
    "sec-fetch-dest": options.destination ?? "empty",
    "sec-fetch-mode": options.mode ?? "cors",
    "sec-fetch-site": options.site ?? "same-origin",
    priority: options.priority ?? "u=1, i",
    dnt: "1",
    cookie: cookieHeader(account),
  };
  if (options.contentType === null) delete headers["content-type"];
  return headers;
}

export function createImpitTransport(options = {}) {
  const client = new Impit({ browser: "chrome", ...options });
  return {
    client,
    fetch(url, requestOptions) {
      return client.fetch(url, requestOptions);
    },
  };
}

export async function invokeTransport(transport, url, options) {
  if (typeof transport === "function") return transport(url, options);
  if (transport && typeof transport.fetch === "function") return transport.fetch(url, options);
  throw new TypeError("Transport must be a function or expose fetch().");
}

export function parseClientVersion(html) {
  const text = String(html ?? "");
  return (
    /data-notion-version=["'](\d+\.\d+\.\d{8}\.\d+)["']/.exec(text)?.[1] ??
    /version\s*:\s*["'](\d+\.\d+\.\d{8}\.\d+)["']/.exec(text)?.[1] ??
    null
  );
}

function splitSetCookieHeader(value) {
  const input = String(value ?? "");
  if (!input) return [];
  const values = [];
  let start = 0;
  let inExpires = false;
  for (let index = 0; index < input.length; index += 1) {
    const rest = input.slice(index);
    if (!inExpires && /^expires=/i.test(rest)) {
      inExpires = true;
      index += "expires=".length - 1;
      continue;
    }
    const character = input[index];
    if (inExpires && character === ";") {
      inExpires = false;
      continue;
    }
    if (character !== ",") continue;
    const following = input.slice(index + 1);
    const cookieStart = /^\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+\s*=/.test(following);
    if (!cookieStart) continue;
    values.push(input.slice(start, index).trim());
    start = index + 1;
    inExpires = false;
  }
  values.push(input.slice(start).trim());
  return values.filter(Boolean);
}

function headerValues(headers) {
  if (!headers) return [];
  if (typeof headers.getSetCookie === "function") {
    const values = headers.getSetCookie();
    if (Array.isArray(values) && values.length > 0) return values;
  }
  if (typeof headers.raw === "function") {
    const raw = headers.raw();
    const values = raw?.["set-cookie"] ?? raw?.["Set-Cookie"];
    if (Array.isArray(values) && values.length > 0) return values;
  }
  let combined = null;
  if (typeof headers.get === "function") combined = headers.get("set-cookie");
  else combined = headers["set-cookie"] ?? headers["Set-Cookie"] ?? null;
  return splitSetCookieHeader(combined);
}

export function responseCookies(response) {
  const cookies = {};
  for (const value of headerValues(response?.headers)) {
    const pair = String(value).split(";", 1)[0];
    const separator = pair.indexOf("=");
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    if (!name) continue;
    cookies[name] = pair.slice(separator + 1).trim();
  }
  return cookies;
}

function shellHeaders(account, cookie, navigation = false) {
  const headers = {
    accept: "text/html,application/xhtml+xml",
    "accept-language": "en-US,en;q=0.9",
    "user-agent": account.user_agent,
  };
  if (!navigation) return headers;
  return {
    ...headers,
    "sec-ch-ua": secChUa(account.user_agent),
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
    "sec-fetch-dest": "document",
    "sec-fetch-mode": "navigate",
    "sec-fetch-site": "none",
    priority: "u=0, i",
    ...(cookie ? { cookie } : {}),
  };
}

export async function fetchLiveClientVersion({
  account,
  transport = createImpitTransport(),
  webBaseUrl = NOTION_WEB_BASE_URL,
} = {}) {
  let response;
  try {
    response = await invokeTransport(transport, `${webBaseUrl}/ai`, {
      method: "GET",
      headers: shellHeaders(account, null, false),
      redirect: "follow",
      timeout: SHELL_TIMEOUT_MS,
    });
  } catch (error) {
    if (error instanceof NotionAgentError) throw error;
    throw new NotionAgentError("Unable to reach the Notion web application.", {
      code: ErrorCode.TRANSPORT,
      cause: error,
    });
  }
  if (response.status !== 200) {
    throw new NotionAgentError("Notion returned an unsuccessful web-application response.", {
      code: ErrorCode.HTTP_ERROR,
      responseStatus: response.status,
    });
  }
  let html;
  try {
    html = await response.text();
  } catch (error) {
    throw new NotionAgentError("Unable to read the Notion web-application response.", {
      code: ErrorCode.TRANSPORT,
      responseStatus: response.status,
      cause: error,
    });
  }
  const clientVersion = parseClientVersion(html);
  if (!clientVersion) {
    throw new NotionAgentError("The Notion client version was not present in the web application.", {
      code: ErrorCode.HTTP_ERROR,
      responseStatus: response.status,
    });
  }
  return clientVersion;
}

export async function fetchSessionWarmup({
  account,
  transport = createImpitTransport(),
  webBaseUrl = NOTION_WEB_BASE_URL,
} = {}) {
  let response;
  try {
    response = await invokeTransport(transport, `${webBaseUrl}/ai`, {
      method: "GET",
      headers: shellHeaders(account, cookieHeader(account), true),
      redirect: "follow",
      timeout: SHELL_TIMEOUT_MS,
    });
  } catch (error) {
    if (error instanceof NotionAgentError) throw error;
    throw new NotionAgentError("Unable to warm the Notion browser session.", {
      code: ErrorCode.TRANSPORT,
      cause: error,
    });
  }

  const cookies = responseCookies(response);
  let clientVersion = null;
  if (response.status === 200) {
    try {
      clientVersion = parseClientVersion(await response.text());
    } catch (error) {
      throw new NotionAgentError("Unable to read the Notion session-warmup response.", {
        code: ErrorCode.TRANSPORT,
        responseStatus: response.status,
        cause: error,
      });
    }
  }
  return { clientVersion, cookies, status: response.status };
}
