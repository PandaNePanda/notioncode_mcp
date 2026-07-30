#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const [
  templatePath,
  destination,
  projectRoot,
  userHome,
  notionMcpEnabled,
  requestedReasoningEffort = "",
] = process.argv.slice(2);
const supportedReasoningEfforts = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);
if (
  !templatePath
  || !destination
  || !projectRoot
  || !userHome
  || !["true", "false"].includes(notionMcpEnabled)
  || (requestedReasoningEffort && !supportedReasoningEfforts.has(requestedReasoningEffort))
) {
  throw new Error(
    "usage: install-codex-config.mjs <template> <destination> <project-root> <user-home> <notion-mcp-enabled:true|false> [reasoning-effort:low|medium|high|xhigh|max|ultra]",
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
  "service_tier",
  "enabled-reasoning-efforts",
  "show-ultra-in-model-picker-slider",
  "model_context_window",
  "model_auto_compact_token_limit",
  "model_auto_compact_token_limit_scope",
  "tool_output_token_limit",
  "model_catalog_json",
]);
const DESKTOP_KEYS = new Set([
  "show-ultra-in-model-picker-slider",
  "enabled-reasoning-efforts",
]);
const MANAGED_DESKTOP_LINES = [
  "show-ultra-in-model-picker-slider = true",
  'enabled-reasoning-efforts = ["low", "medium", "high", "xhigh", "max", "ultra"]',
];
const MANAGED_TABLES = new Set([
  "model_providers.notion-ai",
  "mcp_servers.notion-private",
  "mcp_servers.external-inference",
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
  const rootLines = [];
  const sections = [];
  let currentSection = null;
  for (const line of lines) {
    const table = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if (table) {
      currentSection = {
        name: table[1].trim(),
        header: line,
        lines: [],
      };
      sections.push(currentSection);
      continue;
    }
    if (currentSection) currentSection.lines.push(line);
    else rootLines.push(line);
  }

  const cleanedRoot = rootLines.filter((line) => {
    const assignment = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/);
    return !(assignment && ROOT_KEYS.has(assignment[1]));
  });
  const desktopSections = sections.filter((section) => section.name === "desktop");
  const desktopLines = desktopSections.flatMap((section) => section.lines).filter((line) => {
    const assignment = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/);
    return !(assignment && DESKTOP_KEYS.has(assignment[1]));
  });
  const renderedSections = [];
  let desktopWritten = false;
  for (const section of sections) {
    if (MANAGED_TABLES.has(section.name)) continue;
    if (section.name === "desktop") {
      if (desktopWritten) continue;
      desktopWritten = true;
      renderedSections.push([
        section.header,
        ...MANAGED_DESKTOP_LINES,
        ...desktopLines,
      ].join("\n").trim());
      continue;
    }
    const sectionLines = section.name === "features"
      ? section.lines.filter((line) => {
          const assignment = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/);
          return !(
            assignment
            && ["apps", "plugins", "remote_plugin"].includes(assignment[1])
            && /^\s*[A-Za-z0-9_-]+\s*=\s*false\s*(?:#.*)?$/.test(line)
          );
        })
      : section.lines;
    renderedSections.push([section.header, ...sectionLines].join("\n").trim());
  }
  if (!desktopWritten) {
    renderedSections.push(["[desktop]", ...MANAGED_DESKTOP_LINES].join("\n"));
  }
  return [cleanedRoot.join("\n").trim(), ...renderedSections]
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

const existing = fs.existsSync(destination)
  ? fs.readFileSync(destination, "utf8")
  : "";
const existingReasoningEffort = existing.match(
  /^[^\S\r\n]*model_reasoning_effort[^\S\r\n]*=[^\S\r\n]*"(low|medium|high|xhigh|max|ultra)"[^\S\r\n]*(?:#[^\r\n]*)?$/m,
)?.[1];
let rendered = render(fs.readFileSync(templatePath, "utf8")).trim();
const effectiveReasoningEffort = requestedReasoningEffort || existingReasoningEffort;
if (effectiveReasoningEffort) {
  rendered = rendered.replace(
    /^[^\S\r\n]*model_reasoning_effort[^\S\r\n]*=[^\r\n]*/m,
    `model_reasoning_effort = "${effectiveReasoningEffort}"`,
  );
}
const firstTable = rendered.search(/^\s*\[/m);
if (firstTable === -1) throw new Error("Codex template has no provider table");
const managedRoot = rendered.slice(0, firstTable).trim();
const managedTables = rendered.slice(firstTable).trim();
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
