import { chmod, copyFile, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import {
  defaultAccountHome,
  discoverAccountPaths,
  loadAccount,
  saveAccount,
  sha256,
} from "./account.js";
import { bootstrapAccount } from "./bootstrap.js";
import { AmbiguousWorkspaceError } from "./errors.js";
import { createImpitTransport } from "./transport.js";

export const MIGRATE_HELP = `Usage: notion-agent migrate [account-home] [options]

Migrate legacy Notion account files safely.

Options:
  --dry-run       Inspect and bootstrap without changing account files
  --delay SECONDS Delay between Notion bootstrap requests (default: 1)
  -h, --help      Show this help
`;

export function legacyCookie(data) {
  if (typeof data?.full_cookie === "string" && data.full_cookie.trim()) {
    return data.full_cookie.trim();
  }
  const userId = data?.user_id || data?.notion_user_id || "";
  const browserId = data?.browser_id || data?.notion_browser_id || "";
  const values = [
    ["notion_browser_id", browserId],
    ["device_id", data?.device_id || ""],
    ["notion_user_id", userId],
    ["notion_users", userId ? `[%22${userId}%22]` : ""],
    ["csrf", data?.csrf || ""],
    ["__cf_bm", data?.__cf_bm || ""],
    ["_cfuvid", data?._cfuvid || ""],
    ["token_v2", data?.token_v2 || ""],
  ];
  return values.filter(([, value]) => value).map(([name, value]) => `${name}=${value}`).join("; ");
}

async function fileExists(filePath) {
  try {
    await readFile(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function writeMigratedAccount(filePath, account) {
  const backup = `${filePath}.legacy-backup`;
  if ((await fileExists(filePath)) && !(await fileExists(backup))) {
    await copyFile(filePath, backup);
    if (process.platform !== "win32") await chmod(backup, 0o600);
  }
  await saveAccount(filePath, account);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function migrateAccounts(accountHome, {
  bootstrapFn = bootstrapAccount,
  delaySeconds = 1,
  dryRun = false,
  transport = globalThis.fetch,
} = {}) {
  const candidates = await discoverAccountPaths(accountHome);
  const known = new Map();
  const migrated = [];
  const duplicates = [];
  const failed = [];
  const autoSelectedWorkspaces = [];
  let networkCalls = 0;

  for (const { accountPath } of candidates) {
    try {
      const account = await loadAccount(accountPath);
      known.set(sha256(account.token_v2), account);
      if (process.platform !== "win32" && !dryRun) await chmod(accountPath, 0o600);
    } catch {
      // Legacy and malformed files are handled in the migration pass below.
    }
  }

  for (const { accountPath } of candidates) {
    try {
      await loadAccount(accountPath);
      continue;
    } catch {
      // Continue with legacy parsing.
    }
    try {
      const data = JSON.parse(await readFile(accountPath, "utf8"));
      const token = typeof data?.token_v2 === "string" ? data.token_v2.trim() : "";
      if (!token) throw new Error("token_v2 is missing");
      const fingerprint = sha256(token);
      const cookie = legacyCookie(data);
      let account = known.get(fingerprint);
      if (account) {
        if (cookie) account = { ...account, full_cookie: cookie };
        duplicates.push(path.basename(accountPath));
      } else {
        const bootstrapOptions = {
          tokenV2: token,
          userId: data.user_id || data.notion_user_id || null,
          browserId: data.browser_id || data.notion_browser_id || undefined,
          transport,
        };
        try {
          account = await bootstrapFn(bootstrapOptions);
        } catch (error) {
          if (!(error instanceof AmbiguousWorkspaceError)) throw error;
          const names = new Set(error.workspaces.map((workspace) => workspace.space_name || ""));
          const domains = new Set(error.workspaces.map((workspace) => workspace.domain || ""));
          if (names.size !== 1 || domains.size !== 1) throw error;
          account = await bootstrapFn({ ...bootstrapOptions, spaceName: [...names][0] });
          autoSelectedWorkspaces.push(path.basename(accountPath));
        }
        if (cookie) account = { ...account, full_cookie: cookie };
        known.set(fingerprint, account);
        networkCalls += 1;
        if (delaySeconds > 0) await sleep(delaySeconds * 1000);
      }
      if (!dryRun) await writeMigratedAccount(accountPath, account);
      migrated.push(path.basename(accountPath));
    } catch (error) {
      failed.push({ file: path.basename(accountPath), error: errorMessage(error) });
    }
  }

  return {
    discovered: candidates.length,
    valid_before: candidates.length - migrated.length - failed.length,
    migrated,
    duplicates,
    failed,
    auto_selected_workspaces: autoSelectedWorkspaces,
    network_calls: networkCalls,
    dry_run: dryRun,
  };
}

export function parseMigrateArgs(argv) {
  const options = {
    accountHome: defaultAccountHome(),
    dryRun: false,
    delaySeconds: 1,
    help: false,
  };
  let homeSeen = false;
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (raw === "-h" || raw === "--help") {
      options.help = true;
    } else if (raw === "--dry-run") {
      options.dryRun = true;
    } else if (raw === "--delay" || raw.startsWith("--delay=")) {
      const value = raw.startsWith("--delay=") ? raw.slice("--delay=".length) : argv[++index];
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed < 0) throw new Error("--delay requires a non-negative number.");
      options.delaySeconds = parsed;
    } else if (!raw.startsWith("-") && !homeSeen) {
      options.accountHome = path.resolve(raw);
      homeSeen = true;
    } else {
      throw new Error(`Unknown migrate option: ${raw}`);
    }
  }
  return options;
}

export async function runMigrateCommand(argv, {
  stdout = process.stdout,
  stderr = process.stderr,
  transport = createImpitTransport(),
  migrateFn = migrateAccounts,
} = {}) {
  let options;
  try {
    options = parseMigrateArgs(argv);
  } catch (error) {
    stderr.write(`error: ${errorMessage(error)}\n`);
    return 2;
  }
  if (options.help) {
    stdout.write(MIGRATE_HELP);
    return 0;
  }
  const result = await migrateFn(options.accountHome, {
    delaySeconds: options.delaySeconds,
    dryRun: options.dryRun,
    transport,
  });
  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.failed.length > 0 ? 1 : 0;
}
