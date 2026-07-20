import path from "node:path";
import process from "node:process";
import {
  defaultAccountHome,
  hasJarvisBinding,
  loadAccount,
  saveAccount,
} from "./account.js";
import { fetchUserContent } from "./bootstrap.js";
import { ErrorCode, NotionAgentError } from "./errors.js";
import { loadUserModelAliases, modelMapPath } from "./models.js";
import {
  createImpitTransport,
  fetchLiveClientVersion,
} from "./transport.js";

export const DOCTOR_HELP = `Usage: notion-agent doctor [options]

Validate the account file and ping Notion.

Options:
  --account PATH             Account file to check
  --json                     Emit a structured JSON report
  --refresh-client-version   Save Notion's current web build version
  -h, --help                 Show this help
`;

export class DoctorUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "DoctorUsageError";
  }
}

function writeLine(stream, value = "") {
  stream.write(`${value}\n`);
}

function pythonString(value) {
  return `'${String(value).replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function pythonStringList(values) {
  return `[${values.map((value) => pythonString(value)).join(", ")}]`;
}

function errorDetail(error) {
  const code = error instanceof NotionAgentError ? error.code : ErrorCode.UNKNOWN;
  const message = error instanceof Error ? error.message : String(error);
  return `[${code}] ${message}`;
}

export function parseDoctorArgs(argv) {
  const options = {
    accountPath: path.join(defaultAccountHome(), "notion_account.json"),
    json: false,
    refreshClientVersion: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (raw === "-h" || raw === "--help") {
      options.help = true;
      continue;
    }
    if (raw === "--json") {
      options.json = true;
      continue;
    }
    if (raw === "--refresh-client-version") {
      options.refreshClientVersion = true;
      continue;
    }
    if (raw === "--account" || raw.startsWith("--account=")) {
      const value = raw.startsWith("--account=") ? raw.slice("--account=".length) : argv[++index];
      if (!value || value.startsWith("--")) {
        throw new DoctorUsageError("--account requires a value.");
      }
      options.accountPath = value;
      continue;
    }
    throw new DoctorUsageError(`Unknown doctor option: ${raw}`);
  }
  return options;
}

export function renderDoctor(checks, { asJson = false } = {}) {
  if (asJson) return JSON.stringify(checks, null, 2);
  const icons = { ok: "[ok]  ", fail: "[FAIL]", info: "[..]  " };
  return checks
    .map(({ status, check, detail }) => {
      const line = `${icons[status] ?? "[?]   "} ${check}`;
      return detail ? `${line}  -- ${detail}` : line;
    })
    .join("\n");
}

function buildDate(version) {
  const value = String(version ?? "").split(".")[2];
  if (!/^\d{8}$/.test(value ?? "")) return null;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

export function clientVersionDaysBehind(stored, live) {
  const storedDate = buildDate(stored);
  const liveDate = buildDate(live);
  if (!storedDate || !liveDate) return null;
  return Math.trunc((liveDate.getTime() - storedDate.getTime()) / 86_400_000);
}

export async function runDoctorCommand(
  argv,
  {
    stdout = process.stdout,
    stderr = process.stderr,
    transport = null,
    loadAccountFn = loadAccount,
    saveAccountFn = saveAccount,
    fetchUserContentFn = fetchUserContent,
    fetchLiveClientVersionFn = fetchLiveClientVersion,
    loadUserModelAliasesFn = loadUserModelAliases,
    modelMapFile = modelMapPath(defaultAccountHome()),
    createTransportFn = createImpitTransport,
  } = {},
) {
  let options;
  try {
    options = parseDoctorArgs(argv);
  } catch (error) {
    if (!(error instanceof DoctorUsageError)) throw error;
    writeLine(stderr, `error: ${error.message}`);
    return 2;
  }
  if (options.help) {
    stdout.write(DOCTOR_HELP);
    return 0;
  }

  const checks = [];
  const finish = (exitCode) => {
    writeLine(stdout, renderDoctor(checks, { asJson: options.json }));
    return exitCode;
  };

  let account;
  try {
    account = await loadAccountFn(options.accountPath);
  } catch (error) {
    checks.push({
      status: "fail",
      check: "account file readable",
      detail: errorDetail(error),
    });
    return finish(1);
  }
  checks.push({ status: "ok", check: "account file readable", detail: options.accountPath });
  checks.push({
    status: "ok",
    check: "required fields present",
    detail:
      `user=${account.user_email || account.user_id}  ` +
      `space=${pythonString(account.space_name || "")} (${account.space_id})`,
  });

  if (hasJarvisBinding(account)) {
    const mode = account.agent_binding_mode || "unknown — re-run `notion-agent init` to record";
    checks.push({
      status: "ok",
      check: "custom-agent binding",
      detail:
        `${pythonString(account.agent_name)}  page=${account.agent_context_page_id}  ` +
        `binding_mode=${mode}`,
    });
  } else {
    checks.push({
      status: "info",
      check: "custom-agent binding",
      detail: "(none — chats appear in the default ✦ AI surface)",
    });
  }

  const activeTransport = transport ?? createTransportFn();
  let payload;
  try {
    payload = await fetchUserContentFn({
      tokenV2: account.token_v2,
      userId: account.user_id,
      browserId: account.browser_id || "",
      clientVersion: account.client_version,
      userAgent: account.user_agent,
      transport: activeTransport,
    });
  } catch (error) {
    checks.push({
      status: "fail",
      check: "token_v2 accepted by /loadUserContent",
      detail: errorDetail(error),
    });
    return finish(1);
  }
  checks.push({ status: "ok", check: "token_v2 accepted by /loadUserContent", detail: "" });

  const spaces = Object.keys(payload?.recordMap?.space ?? {});
  if (spaces.includes(account.space_id)) {
    checks.push({
      status: "ok",
      check: "bound space_id present in workspaces",
      detail: `${spaces.length} workspaces total`,
    });
  } else {
    checks.push({
      status: "fail",
      check: "bound space_id present in workspaces",
      detail: `bound=${pythonString(account.space_id)} but server returned ${pythonStringList(spaces)}`,
    });
    return finish(1);
  }

  const userAliases = await loadUserModelAliasesFn(modelMapFile);
  if (Object.keys(userAliases).length > 0) {
    checks.push({
      status: "ok",
      check: "user model map loaded",
      detail: `${Object.keys(userAliases).length} aliases at ${modelMapFile}`,
    });
  } else {
    checks.push({
      status: "info",
      check: "user model map",
      detail: "(none — falls back to DEFAULT_MODEL_MAP in models.js)",
    });
  }

  if (options.refreshClientVersion) {
    const stored = account.client_version;
    try {
      const live = await fetchLiveClientVersionFn({ account, transport: activeTransport });
      const behind = clientVersionDaysBehind(stored, live);
      if (stored === live) {
        checks.push({
          status: "ok",
          check: "client_version refreshed",
          detail: `already current (${live})`,
        });
      } else {
        await saveAccountFn(options.accountPath, { ...account, client_version: live });
        const was = behind !== null && behind > 0 ? ` (was ${behind}d behind)` : "";
        checks.push({
          status: "ok",
          check: "client_version refreshed",
          detail: `${stored} → ${live}${was}`,
        });
      }
    } catch (error) {
      const code = error instanceof NotionAgentError ? error.code : ErrorCode.UNKNOWN;
      checks.push({
        status: "info",
        check: "client_version freshness",
        detail: `could not read live build ([${code}]); stored=${stored}`,
      });
    }
  }
  return finish(0);
}
