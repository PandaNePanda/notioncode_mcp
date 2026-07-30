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

function install(config, initial = "", notionMcpEnabled = "false", reasoningEffort = "") {
  fs.mkdirSync(path.dirname(config), { recursive: true });
  if (initial) fs.writeFileSync(config, initial);
  const result = spawnSync(
    process.execPath,
    [installer, template, config, root, "/home/tester", notionMcpEnabled, reasoningEffort],
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
    assert.match(output, /model = "opus-5"/);
    assert.match(output, /model_reasoning_effort = "medium"/);
    assert.match(output, /model_provider = "notion-ai"/);
    assert.match(output, /model_context_window = 210000/);
    assert.match(output, /model_auto_compact_token_limit = 200000/);
    assert.match(output, /model_auto_compact_token_limit_scope = "total"/);
    assert.match(output, /tool_output_token_limit = 12000/);
    assert.equal(output.includes("[mcp_servers.external-inference]"), true);
    assert.equal(output.includes("run-external-inference.js"), true);
    const externalSection = output.match(
      /\[mcp_servers\.external-inference\]([\s\S]*?)(?=\n\[|$)/,
    )?.[1] ?? "";
    assert.match(externalSection, /enabled = true/);
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
    assert.equal(second.split("[mcp_servers.external-inference]").length - 1, 1);
    assert.equal(second.includes("OPENROUTER_API_KEY ="), false);
    assert.equal(second.includes("VIVGRID_API_KEY ="), false);
    assert.equal(second.includes("CEREBRAS_API_KEY ="), false);
    assert.equal((second.match(/BEGIN notioncode_mcp managed root/g) || []).length, 1);
    assert.equal((second.match(/\[model_providers\.notion-ai]/g) || []).length, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("preserves the user's explicit reasoning effort across reinstalls", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "notioncode-config-"));
  try {
    const config = path.join(directory, "config.toml");
    const output = install(config, [
      'model_reasoning_effort = "high"',
      'approval_policy = "on-request"',
      "",
    ].join("\n"));
    assert.match(output, /model_reasoning_effort = "high"/);
    assert.doesNotMatch(output, /model_reasoning_effort = "low"/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("allows every supported reasoning effort override", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "notioncode-config-"));
  try {
    for (const effort of ["low", "medium", "high", "xhigh", "max", "ultra"]) {
      const config = path.join(directory, `${effort}.toml`);
      const output = install(
        config,
        'model_reasoning_effort = "low"\n',
        "false",
        effort,
      );
      assert.match(output, new RegExp(`model_reasoning_effort = "${effort}"`));
      assert.equal(
        (output.match(/^model_reasoning_effort\s*=/gm) || []).length,
        1,
      );
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("enables Notion MCP only after the credential gate passes", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "notioncode-config-"));
  try {
    const config = path.join(directory, "config.toml");
    const disabled = install(config, "", "false");
    const disabledNotionSection = disabled.match(
      /\[mcp_servers\.notion-private\]([\s\S]*?)(?=\n\[|$)/,
    )?.[1] ?? "";
    assert.match(disabledNotionSection, /enabled = false/);
    const enabled = install(config, disabled, "true");
    const enabledNotionSection = enabled.match(
      /\[mcp_servers\.notion-private\]([\s\S]*?)(?=\n\[|$)/,
    )?.[1] ?? "";
    assert.match(enabledNotionSection, /enabled = true/);
    assert.doesNotMatch(enabledNotionSection, /enabled = false/);
    assert.equal(enabled.split("[mcp_servers.external-inference]").length - 1, 1);
    const externalSection = enabled.match(
      /\[mcp_servers\.external-inference\]([\s\S]*?)(?=\n\[|$)/,
    )?.[1] ?? "";
    assert.match(externalSection, /enabled = true/);
    assert.equal((enabled.match(/\[mcp_servers\.notion-private]/g) || []).length, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("normalizes root and Desktop Fast settings while preserving Desktop preferences", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "notioncode-config-"));
  try {
    const config = path.join(directory, "config.toml");
    const initial = [
      'service_tier = "standard"',
      'enabled-reasoning-efforts = ["low", "medium"]',
      "show-ultra-in-model-picker-slider = false",
      'approval_policy = "on-request"',
      "",
      "[desktop]",
      'localeOverride = "ko-KR"',
      'followUpQueueMode = "queue"',
      "show-ultra-in-model-picker-slider = false",
      'enabled-reasoning-efforts = ["low", "medium", "high"]',
      "",
    ].join("\n");
    const first = install(config, initial);
    assert.match(first, /approval_policy = "on-request"/);
    assert.match(first, /localeOverride = "ko-KR"/);
    assert.match(first, /followUpQueueMode = "queue"/);
    assert.equal((first.match(/^\[desktop\]$/gm) || []).length, 1);
    assert.equal((first.match(/^service_tier\s*=\s*"priority"$/gm) || []).length, 1);
    assert.equal((first.match(/^show-ultra-in-model-picker-slider\s*=\s*true$/gm) || []).length, 2);
    assert.equal((first.match(/^enabled-reasoning-efforts\s*=\s*\["low", "medium", "high", "xhigh", "max", "ultra"\]$/gm) || []).length, 2);
    assert.doesNotMatch(first, /show-ultra-in-model-picker-slider\s*=\s*false/);
    assert.doesNotMatch(first, /service_tier\s*=\s*"standard"/);
    assert.equal(install(config, first), first);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("adds canonical Desktop settings when the table or managed keys are absent", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "notioncode-config-"));
  try {
    for (const [name, initial] of [
      ["none", 'approval_policy = "on-request"\n'],
      ["existing", '[desktop]\nlocaleOverride = "ko-KR"\n'],
    ]) {
      const config = path.join(directory, `${name}.toml`);
      const output = install(config, initial);
      assert.equal((output.match(/^\[desktop\]$/gm) || []).length, 1);
      assert.equal((output.match(/^show-ultra-in-model-picker-slider\s*=\s*true$/gm) || []).length, 2);
      assert.equal((output.match(/^enabled-reasoning-efforts\s*=/gm) || []).length, 2);
      assert.equal((output.match(/^service_tier\s*=\s*"priority"$/gm) || []).length, 1);
      if (name === "existing") assert.match(output, /localeOverride = "ko-KR"/);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("merges duplicate Desktop tables without moving preferences into another table", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "notioncode-config-"));
  try {
    const config = path.join(directory, "config.toml");
    const output = install(config, [
      "[desktop]",
      'localeOverride = "ko-KR"',
      "",
      "[features]",
      "shell_snapshot = true",
      "",
      "[desktop]",
      'openLinksIn = "browser"',
      "",
    ].join("\n"));
    assert.equal((output.match(/^\[desktop\]$/gm) || []).length, 1);
    const desktopSection = output.match(/\[desktop\]([\s\S]*?)(?=\n\[|\n# BEGIN notioncode_mcp managed tables|$)/)?.[1] ?? "";
    const featuresSection = output.match(/\[features\]([\s\S]*?)(?=\n\[|\n# BEGIN notioncode_mcp managed tables|$)/)?.[1] ?? "";
    assert.match(desktopSection, /localeOverride = "ko-KR"/);
    assert.match(desktopSection, /openLinksIn = "browser"/);
    assert.match(featuresSection, /shell_snapshot = true/);
    assert.doesNotMatch(featuresSection, /openLinksIn/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
