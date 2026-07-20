#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const [templatePath, destination, projectRoot, userHome, notionMcpEnabled] = process.argv.slice(2);
if (
  !templatePath
  || !destination
  || !projectRoot
  || !userHome
  || !["true", "false"].includes(notionMcpEnabled)
) {
  throw new Error(
    "usage: install-codex-config.mjs <template> <destination> <project-root> <user-home> <notion-mcp-enabled:true|false>",
  );
}

const ROOT_BEGIN = "# BEGIN notioncode_mcp managed root";
const ROOT_END = "# END notioncode_mcp managed root";
const TABLES_BEGIN = "# BEGIN notioncode_mcp managed tables";
const TABLES_END = "# END notioncode_mcp managed tables";
const ROOT_KEYS = new Set([
  "model",
  "model_provider",
  "model_reasoning_effort",
  "model_context_window",
  "model_auto_compact_token_limit",
  "model_auto_compact_token_limit_scope",
  "tool_output_token_limit",
  "model_catalog_json",
]);
const MANAGED_TABLES = new Set([
  "model_providers.notion-ai",
  "mcp_servers.notion-private",
]);

function portable(value) {
  const normalized = value.replaceAll("\\", "/");
  if (/^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//")) {
    return normalized;
  }
  return path.resolve(value).replaceAll("\\", "/");
}

function render(value) {
  return value
    .replaceAll("__NOTIONCODE_ROOT__", portable(projectRoot))
    .replaceAll("__USER_HOME__", portable(userHome))
    .replaceAll("false # __NOTION_MCP_ENABLED__", notionMcpEnabled);
}

function withoutManagedMarkers(value) {
  const blocks = [
    [ROOT_BEGIN, ROOT_END],
    [TABLES_BEGIN, TABLES_END],
  ];
  let result = value;
  for (const [begin, end] of blocks) {
    const start = result.indexOf(begin);
    if (start === -1) continue;
    const finish = result.indexOf(end, start);
    if (finish === -1) {
      throw new Error(`Malformed Codex config: found ${begin} without ${end}`);
    }
    result = result.slice(0, start) + result.slice(finish + end.length);
  }
  return result;
}

function cleanExisting(value) {
  const lines = withoutManagedMarkers(value).split(/\r?\n/);
  const kept = [];
  let currentTable = null;
  let skipManagedTable = false;
  for (const line of lines) {
    const table = line.match(/^\s*\[([^\]]+)]\s*(?:#.*)?$/);
    if (table) {
      currentTable = table[1].trim();
      skipManagedTable = MANAGED_TABLES.has(currentTable);
      if (!skipManagedTable) kept.push(line);
      continue;
    }
    if (skipManagedTable) continue;
    const assignment = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/);
    if (currentTable === null && assignment && ROOT_KEYS.has(assignment[1])) continue;
    if (
      currentTable === "features"
      && assignment
      && ["apps", "plugins", "remote_plugin"].includes(assignment[1])
      && /^\s*[A-Za-z0-9_-]+\s*=\s*false\s*(?:#.*)?$/.test(line)
    ) {
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n").trim();
}

const rendered = render(fs.readFileSync(templatePath, "utf8")).trim();
const firstTable = rendered.search(/^\s*\[/m);
if (firstTable === -1) throw new Error("Codex template has no provider table");
const managedRoot = rendered.slice(0, firstTable).trim();
const managedTables = rendered.slice(firstTable).trim();
const existing = fs.existsSync(destination)
  ? fs.readFileSync(destination, "utf8")
  : "";
const cleaned = cleanExisting(existing);
const firstExistingTable = cleaned.search(/^\s*\[/m);
const existingRoot = firstExistingTable === -1 ? cleaned : cleaned.slice(0, firstExistingTable).trim();
const existingTables = firstExistingTable === -1 ? "" : cleaned.slice(firstExistingTable).trim();
const pieces = [
  existingRoot,
  `${ROOT_BEGIN}\n${managedRoot}\n${ROOT_END}`,
  existingTables,
  `${TABLES_BEGIN}\n${managedTables}\n${TABLES_END}`,
].filter(Boolean);
const next = `${pieces.join("\n\n")}\n`;

fs.mkdirSync(path.dirname(destination), { recursive: true });
if (existing && existing !== next) {
  const stamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
  fs.copyFileSync(destination, `${destination}.notioncode-backup-${stamp}`);
}
fs.writeFileSync(destination, next, "utf8");
if (process.platform !== "win32") fs.chmodSync(destination, 0o600);

console.log(`Codex VS Code provider installed in ${destination}`);
