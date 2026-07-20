#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const renderer = path.join(root, "scripts", "render-config.mjs");

test("renders the portable unified systemd service", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "notioncode-systemd-"));
  try {
    const source = path.join(root, "deploy", "systemd", "notion-fable-proxy.service");
    const destination = path.join(directory, "notion-fable-proxy.service");
    const result = spawnSync(process.execPath, [
      renderer,
      source,
      destination,
      "/srv/notioncode",
      "/home/alice",
      "alice",
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const rendered = fs.readFileSync(destination, "utf8");
    assert.match(rendered, /User=alice/);
    assert.match(rendered, /Environment=HOME=\/home\/alice/);
    assert.match(rendered, /ExecStart=\/usr\/bin\/env node \/srv\/notioncode\/bridge\/server\.js/);
    assert.match(rendered, /EnvironmentFile=\/srv\/notioncode\/runtime\/\.env/);
    assert.doesNotMatch(rendered, /uvicorn|runtime\/start\.sh|notion-code-mcp/);
    assert.doesNotMatch(rendered, /__[A-Z0-9_]+__/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
