#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const legacyProjectPath = ["", "root", "notioncode_mcp"].join("/");
const requiredShared = [
  "bridge/server.py",
  "bridge/account_pool.py",
  "bridge/migrate_accounts.py",
  "bridge/turn_affinity.py",
  "bridge/conversation_segments.py",
  "runtime/server.js",
  "runtime/platform.js",
  "notion-private-api-mcp/src/server.js",
  "notion-private-api-mcp/run-from-account.js",
  "config/codex-cli-config.toml",
  "scripts/install-codex-config.mjs",
  "scripts/test-codex-app-server.mjs",
  "scripts/check-public-release.mjs",
  "scripts/render-config.test.mjs",
  "config/opencode.jsonc",
  "state-template/.notionagents/models.json",
];
const forbiddenDuplicates = [
  "windows",
  "public-repo",
  "bin/codex",
  "codex-notion.cmd",
  "config/vscode-remote-settings.json",
];

for (const relative of requiredShared) {
  if (!fs.existsSync(path.join(root, relative))) {
    throw new Error(`Missing shared project file: ${relative}`);
  }
}

for (const relative of [
  "deploy/systemd/notion-code-mcp.service",
  "deploy/systemd/notion-fable-proxy.service",
]) {
  const content = fs.readFileSync(path.join(root, relative), "utf8");
  for (const placeholder of ["__NOTIONCODE_ROOT__", "__USER_HOME__", "__SERVICE_USER__"]) {
    if (!content.includes(placeholder)) {
      throw new Error(`Portable systemd template is missing ${placeholder}: ${relative}`);
    }
  }
  if (content.includes(legacyProjectPath)) {
    throw new Error(`Systemd template contains a machine-specific path: ${relative}`);
  }
}
for (const relative of forbiddenDuplicates) {
  if (fs.existsSync(path.join(root, relative))) {
    throw new Error(`Platform-specific shared-code duplicate is forbidden: ${relative}`);
  }
}

for (const relative of ["config/codex-cli-config.toml", "config/opencode.jsonc"]) {
  const content = fs.readFileSync(path.join(root, relative), "utf8");
  if (!content.includes("__NOTIONCODE_ROOT__")) {
    throw new Error(`Shared config must use __NOTIONCODE_ROOT__: ${relative}`);
  }
  if (/sk-[A-Za-z0-9_-]{12,}/.test(content)) {
    throw new Error(`Shared config contains a credential: ${relative}`);
  }
}

console.log("Unified cross-platform layout is valid.");
