#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
  cwd: root,
  encoding: "utf8",
}).split("\0").filter(Boolean);
const obsoletePaths = new Set([
  "deploy/systemd/notion-code-mcp.service",
  "requirements.txt",
  "bridge/account_pool.py",
  "bridge/conversation_segments.py",
  "bridge/diagnostics.py",
  "bridge/migrate_accounts.py",
  "bridge/notion_images.py",
  "bridge/server.py",
  "bridge/turn_affinity.py",
  "bridge/tests/test_account_pool.py",
  "bridge/tests/test_conversation_segments.py",
  "bridge/tests/test_migrate_accounts.py",
  "bridge/tests/test_notion_images.py",
  "bridge/tests/test_server_regressions.py",
  "bridge/tests/test_turn_affinity.py",
  "install.ps1",
  "start.ps1",
  "status.ps1",
  "stop.ps1",
  "verify.ps1",
  "opencode-notion.cmd",
]);

const forbiddenPaths = [
  /^\.runtime\//,
  /^state\//,
  /(^|\/)\.env$/,
  /(^|\/)runtime\/\.env$/,
  /(^|\/)notion_account\.json$/,
  /(^|\/)accounts\/[^/]+\.json$/,
  /(^|\/)conversation-state\.json$/,
  /(^|\/)pool-state\.json$/,
  /\.legacy-backup$/,
];
const secretPatterns = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["OpenAI-style key", /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ["GitHub token", /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/],
  ["Notion integration token", /\bntn_[A-Za-z0-9_-]{20,}\b/],
  ["Notion token_v2 value", /["']token_v2["']\s*:\s*["'][^"']{20,}["']/i],
  ["generated MCP secret", /MCP_PATH_SECRET=[A-Fa-f0-9]{32,}/],
  ["JWT", /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/],
];

const errors = [];
for (const relative of tracked) {
  if (forbiddenPaths.some((pattern) => pattern.test(relative))) {
    errors.push(`forbidden tracked path: ${relative}`);
    continue;
  }
  const absolute = path.join(root, relative);
  if (!fs.existsSync(absolute)) {
    if (obsoletePaths.has(relative)) continue;
    errors.push(`tracked file missing from working tree: ${relative}`);
    continue;
  }
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.size > 5 * 1024 * 1024) continue;
  const content = fs.readFileSync(absolute, "utf8");
  for (const [label, pattern] of secretPatterns) {
    if (pattern.test(content)) errors.push(`${label} detected in ${relative}`);
  }
  const legacyProjectPath = ["", "root", "notioncode_mcp"].join("/");
  if (content.includes(legacyProjectPath)) {
    errors.push(`machine-specific project path detected in ${relative}`);
  }
}

for (const relative of obsoletePaths) {
  if (fs.existsSync(path.join(root, relative))) {
    errors.push(`obsolete migration file must not be shipped: ${relative}`);
  }
}

for (const required of ["README.md", "LICENSE", "SECURITY.md", "AGENTS.md"]) {
  if (!tracked.includes(required) && !fs.existsSync(path.join(root, required))) {
    errors.push(`missing public repository file: ${required}`);
  }
}

if (errors.length) {
  errors.forEach((error) => console.error(`ERROR: ${error}`));
  process.exit(1);
}

console.log(`Public-release audit passed for ${tracked.length} tracked files.`);
