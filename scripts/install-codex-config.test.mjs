#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const installer = path.join(root, "scripts", "install-codex-config.mjs");
const template = path.join(root, "config", "codex-cli-config.toml");

function install(config, initial = "", notionMcpEnabled = "false") {
  fs.mkdirSync(path.dirname(config), { recursive: true });
  if (initial) fs.writeFileSync(config, initial);
  const result = spawnSync(
    process.execPath,
    [installer, template, config, root, "/home/tester", notionMcpEnabled],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return fs.readFileSync(config, "utf8");
}

test("merges the provider without losing unrelated Codex settings", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "notioncode-config-"));
  try {
    const config = path.join(directory, "config.toml");
    const output = install(config, [
      'model = "gpt-old"',
      'approval_policy = "on-request"',
      "",
      "[features]",
      "apps = false",
      "shell_snapshot = true",
      "",
      "[projects.\"/work\"]",
      'trust_level = "trusted"',
      "",
    ].join("\n"));
    assert.match(output, /model = "gpt-5\.5"/);
    assert.match(output, /model_provider = "notion-ai"/);
    assert.match(output, /model_context_window = 100000/);
    assert.match(output, /model_auto_compact_token_limit = 60000/);
    assert.match(output, /model_auto_compact_token_limit_scope = "total"/);
    assert.match(output, /tool_output_token_limit = 12000/);
    assert.match(output, /\[mcp_servers\.notion-private]/);
    assert.match(output, /enabled = false/);
    assert.match(output, /approval_policy = "on-request"/);
    assert.match(output, /shell_snapshot = true/);
    assert.match(output, /\[projects\."\/work"\]/);
    assert.doesNotMatch(output, /apps = false/);
    assert.equal((output.match(/model_provider =/g) || []).length, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("is idempotent", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "notioncode-config-"));
  try {
    const config = path.join(directory, "config.toml");
    const first = install(config);
    const second = install(config);
    assert.equal(second, first);
    assert.equal((second.match(/BEGIN notioncode_mcp managed root/g) || []).length, 1);
    assert.equal((second.match(/\[model_providers\.notion-ai]/g) || []).length, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("enables Notion MCP only after the credential gate passes", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "notioncode-config-"));
  try {
    const config = path.join(directory, "config.toml");
    const disabled = install(config, "", "false");
    assert.match(disabled, /enabled = false/);
    const enabled = install(config, disabled, "true");
    assert.match(enabled, /enabled = true/);
    assert.doesNotMatch(enabled, /enabled = false/);
    assert.equal((enabled.match(/\[mcp_servers\.notion-private]/g) || []).length, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
