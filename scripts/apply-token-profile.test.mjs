#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(root, "scripts", "apply-token-profile.mjs");

function apply(paths, profile = "") {
  const args = [
    script,
    paths.state,
    paths.codex,
    path.join(root, "config", "codex-models.json"),
    paths.openCode,
  ];
  if (profile) args.push(profile);
  const result = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function catalogLimits(value, result = []) {
  if (Array.isArray(value)) {
    for (const item of value) catalogLimits(item, result);
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (["context_window", "max_context_window", "auto_compact_token_limit"].includes(key)) {
        result.push([key, child]);
      } else {
        catalogLimits(child, result);
      }
    }
  }
  return result;
}

test("applies and persists Safe and Extreme token profiles", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "notioncode-token-profile-"));
  try {
    const paths = {
      state: path.join(directory, "state"),
      codex: path.join(directory, "config.toml"),
      openCode: path.join(directory, "opencode.jsonc"),
    };
    fs.writeFileSync(paths.codex, [
      "model_context_window = 256000",
      "model_auto_compact_token_limit = 140000",
      'model_catalog_json = "old.json"',
      "tool_output_token_limit = 12000",
      "",
    ].join("\n"));
    fs.copyFileSync(path.join(root, "config", "opencode.jsonc"), paths.openCode);

    assert.match(apply(paths, "safe"), /Token profile applied: Safe/);
    assert.equal(fs.readFileSync(path.join(paths.state, "token-profile"), "utf8").trim(), "safe");
    let codex = fs.readFileSync(paths.codex, "utf8");
    assert.match(codex, /model_context_window = 100000/);
    assert.match(codex, /model_auto_compact_token_limit = 60000/);
    assert.match(codex, /model_catalog_json = ".*\/codex-models\.json"/);
    assert.match(codex, /tool_output_token_limit = 12000/);
    let limits = catalogLimits(JSON.parse(
      fs.readFileSync(path.join(paths.state, "codex-models.json"), "utf8"),
    ));
    assert.ok(limits.length > 0);
    assert.ok(limits.every(([key, value]) => value === (key === "auto_compact_token_limit" ? 60000 : 100000)));
    assert.doesNotMatch(fs.readFileSync(paths.openCode, "utf8"), /"context": 256000/);
    assert.match(fs.readFileSync(paths.openCode, "utf8"), /"context": 100000/);

    assert.match(apply(paths, "extreme"), /Token profile applied: Extreme/);
    assert.equal(fs.readFileSync(path.join(paths.state, "token-profile"), "utf8").trim(), "extreme");
    codex = fs.readFileSync(paths.codex, "utf8");
    assert.match(codex, /model_context_window = 256000/);
    assert.match(codex, /model_auto_compact_token_limit = 140000/);
    limits = catalogLimits(JSON.parse(
      fs.readFileSync(path.join(paths.state, "codex-models.json"), "utf8"),
    ));
    assert.ok(limits.every(([key, value]) => value === (key === "auto_compact_token_limit" ? 140000 : 256000)));

    assert.match(apply(paths), /Token profile applied: Extreme/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
