import path from "node:path";
import process from "node:process";
import { defaultAccountHome, hasJarvisBinding } from "./account.js";
import { lookupRegisteredAgentByPageId } from "./agents.js";
import { AmbiguousWorkspaceError, NotionAgentError } from "./errors.js";
import { runDoctorCommand } from "./doctor.js";
import {
  enrichAgentBinding,
  InitUsageError,
  initializeAccount,
  initializeAllWorkspaces,
  resolveInitCredential,
  workspaceSelectionHelp,
} from "./init.js";
import { runMigrateCommand } from "./migrate.js";
import { createImpitTransport } from "./transport.js";

const VALUE_OPTIONS = new Map([
  ["--cookie", "cookie"],
  ["--token-v2", "tokenV2"],
  ["--user-id", "userId"],
  ["--browser-id", "browserId"],
  ["--space-name", "spaceName"],
  ["--space-domain", "spaceDomain"],
  ["--agent-name", "agentName"],
  ["--agent-accessory", "agentAccessory"],
  ["--agent-page-id", "agentContextPageId"],
  ["--default-model", "defaultModel"],
  ["--timezone", "timezone"],
  ["--account", "accountPath"],
  ["--account-home", "accountHome"],
]);

export const INIT_HELP = `Usage: notion-agent init [options]

Bootstrap a Notion account file.

Credential options (use stdin to keep credentials out of shell history):
  --token-v2 -             Read a bare token_v2 value from stdin
  --cookie -               Read a complete browser cookie from stdin

Workspace and account options:
  --space-name NAME        Select a workspace by display name
  --space-domain DOMAIN    Select a workspace by domain slug
  --user-id ID             Override the user id
  --browser-id ID          Override the browser id
  --account PATH           Account output path
  --account-home PATH      Account directory (default: ~/.notionagents)
  --all-workspaces         Save every workspace as an independent account
  --force                  Replace an existing account file

Custom-agent options:
  --agent-name NAME
  --agent-accessory VALUE
  --agent-page-id ID

Other options:
  --default-model MODEL    Default: opus-4.8
  --timezone ZONE          Default: America/Los_Angeles
  -h, --help               Show this help
`;

function writeLine(stream, value = "") {
  stream.write(`${value}\n`);
}

export function parseInitArgs(argv) {
  const options = {
    cookie: null,
    tokenV2: null,
    userId: null,
    browserId: null,
    spaceName: null,
    spaceDomain: null,
    agentName: null,
    agentAccessory: null,
    agentContextPageId: null,
    defaultModel: "opus-4.8",
    timezone: "America/Los_Angeles",
    accountPath: path.join(defaultAccountHome(), "notion_account.json"),
    accountHome: defaultAccountHome(),
    accountPathExplicit: false,
    allWorkspaces: false,
    force: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (raw === "-h" || raw === "--help") {
      options.help = true;
      continue;
    }
    if (raw === "--force") {
      options.force = true;
      continue;
    }
    if (raw === "--all-workspaces") {
      options.allWorkspaces = true;
      continue;
    }

    const separator = raw.indexOf("=");
    const name = separator > 0 ? raw.slice(0, separator) : raw;
    const property = VALUE_OPTIONS.get(name);
    if (!property) throw new InitUsageError(`Unknown init option: ${name}`);
    const value = separator > 0 ? raw.slice(separator + 1) : argv[++index];
    if (value === undefined || (value.startsWith("--") && value !== "-")) {
      throw new InitUsageError(`${name} requires a value.`);
    }
    options[property] = value;
    if (property === "accountPath") options.accountPathExplicit = true;
  }
  if (!options.accountPathExplicit) {
    options.accountPath = path.join(options.accountHome, "notion_account.json");
  }
  return options;
}

function formatInitStatus(account, summary) {
  const lines = [
    `[init] wrote ${summary.account_file}`,
    `[init] workspace: ${JSON.stringify(summary.workspace_name)}  (${summary.workspace_id})`,
    `[init] user:      ${JSON.stringify(summary.user_name)} <${summary.user_email}>`,
  ];
  if (account.full_cookie) {
    lines.splice(
      1,
      0,
      "[init] stored full browser cookie; re-run init with a fresh cookie after trust-rule failures",
    );
  }
  if (hasJarvisBinding(account)) {
    lines.push(
      `[init] agent:     ${JSON.stringify(account.agent_name)}  ` +
        `page=${account.agent_context_page_id}  ` +
        `binding_mode=${account.agent_binding_mode || "unknown"}`,
    );
  } else {
    lines.push("[init] agent:     (default chat; no custom-agent binding)");
  }
  return lines;
}

export async function runInitCommand(
  argv,
  {
    stdin = process.stdin,
    stdout = process.stdout,
    stderr = process.stderr,
    transport = createImpitTransport(),
    lookupAgentByPageId = null,
  } = {},
) {
  try {
    const options = parseInitArgs(argv);
    if (options.help) {
      stdout.write(INIT_HELP);
      return 0;
    }
    const credential = await resolveInitCredential({
      cookie: options.cookie,
      tokenV2: options.tokenV2,
      stdin,
    });
    credential.userId = options.userId || credential.userId;
    credential.browserId = options.browserId || credential.browserId;
    const resolveAgent =
      lookupAgentByPageId ??
      ((account, pageId) => lookupRegisteredAgentByPageId(account, pageId, { transport }));

    if (options.allWorkspaces) {
      if (options.spaceName || options.spaceDomain) {
        throw new InitUsageError("--all-workspaces cannot be combined with workspace selection.");
      }
      if (options.accountPathExplicit) {
        throw new InitUsageError("Use --account-home, not --account, with --all-workspaces.");
      }
      if (options.force) {
        throw new InitUsageError("--force is not supported with --all-workspaces; existing workspaces are skipped.");
      }
      const result = await initializeAllWorkspaces({
        ...options,
        credential,
        transport,
        enrichAccount: (candidate) => enrichAgentBinding(candidate, {
          agentName: options.agentName,
          agentContextPageId: options.agentContextPageId,
          lookupAgentByPageId: resolveAgent,
          warn: (message) => writeLine(stderr, `warning: ${message}`),
          inform: (message) => writeLine(stderr, `[init] ${message}`),
        }),
      });
      for (const { account, summary } of result.created) {
        for (const line of formatInitStatus(account, summary)) writeLine(stdout, line);
      }
      for (const skipped of result.skipped) {
        writeLine(stdout, `[init] already configured: ${JSON.stringify(skipped.workspace_name)} (${skipped.workspace_id})`);
      }
      writeLine(
        stdout,
        `[init] workspaces discovered=${result.discovered_workspaces} created=${result.created.length} skipped=${result.skipped.length}`,
      );
      return 0;
    }

    const { account, summary } = await initializeAccount({
      ...options,
      credential,
      transport,
      enrichAccount: (candidate) =>
        enrichAgentBinding(candidate, {
          agentName: options.agentName,
          agentContextPageId: options.agentContextPageId,
          lookupAgentByPageId: resolveAgent,
          warn: (message) => writeLine(stderr, `warning: ${message}`),
          inform: (message) => writeLine(stderr, `[init] ${message}`),
        }),
    });
    for (const line of formatInitStatus(account, summary)) writeLine(stdout, line);
    return 0;
  } catch (error) {
    if (error instanceof AmbiguousWorkspaceError) {
      writeLine(stderr, "Multiple workspaces available; re-run with --space-name or --space-domain:");
      const choices = workspaceSelectionHelp(error);
      for (const choice of choices) {
        writeLine(
          stderr,
          `  - name=${JSON.stringify(choice.name)}  domain=${JSON.stringify(choice.domain)}  id=${choice.id}`,
        );
      }
      if (choices[0]) {
        writeLine(
          stderr,
          `Try: notion-agent init --token-v2 - --space-domain ${JSON.stringify(choices[0].domain)}`,
        );
      }
      return 3;
    }
    if (error instanceof InitUsageError) {
      writeLine(stderr, `error: ${error.message}`);
      return 2;
    }
    if (error instanceof NotionAgentError) {
      writeLine(stderr, `error: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

export async function runCli(
  argv = process.argv.slice(2),
  dependencies = {},
) {
  const [command, ...rest] = argv;
  if (command === "init") return runInitCommand(rest, dependencies);
  if (command === "doctor") return runDoctorCommand(rest, dependencies);
  if (command === "migrate") return runMigrateCommand(rest, dependencies);
  if (command === "-h" || command === "--help" || command === undefined) {
    (dependencies.stdout || process.stdout).write(
      "Usage: notion-agent <command> [options]\n\nCommands:\n  init\n  doctor\n  migrate\n",
    );
    return command === undefined ? 2 : 0;
  }
  writeLine(dependencies.stderr || process.stderr, `error: unknown command: ${command}`);
  return 2;
}
