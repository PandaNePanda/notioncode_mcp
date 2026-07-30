#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const start = fs.readFileSync(path.join(root, "start.ps1"), "utf8");
const guard = fs.readFileSync(path.join(root, "scripts", "startup-guard.ps1"), "utf8");
const install = fs.readFileSync(path.join(root, "install.ps1"), "utf8");

test("serializes startup and verifies listener ownership before reuse", () => {
  assert.match(start, /Enter-NotionCodeStartupLock/);
  assert.match(start, /finally\s*\{[\s\S]*Exit-NotionCodeStartupLock/);
  assert.match(start, /Get-VerifiedListenerProcess -Port \$runtimePort/);
  assert.match(start, /Get-VerifiedListenerProcess -Port 8765/);
  assert.match(guard, /Local\\notioncode_mcp_start/);
  assert.match(guard, /Get-NetTCPConnection -State Listen/);
  assert.match(guard, /refusing to reuse or replace it/);
});

test("repairs PID files from verified listener owners", () => {
  assert.match(start, /Wait-VerifiedListenerProcess -Port \$runtimePort/);
  assert.match(start, /Wait-VerifiedListenerProcess -Port 8765/);
  assert.match(start, /Set-VerifiedPidFile -Path \$runtimePidFile -ProcessId \$runtimeOwner\.ProcessId/);
  assert.match(start, /Set-VerifiedPidFile -Path \$bridgePidFile -ProcessId \$bridgeOwner\.ProcessId/);
});

test("keeps service startup available when the optional Desktop patch fails", () => {
  assert.doesNotMatch(start, /throw "Codex Desktop Fast compatibility patch failed/);
  assert.match(start, /local services will still be started/);
});

test("installer creates one logged launcher and disables only the known legacy launcher", () => {
  assert.match(install, /startup\.log/);
  assert.match(install, /StartNotionAgent\.vbs/);
  assert.match(install, /notion-agent\\\.exe/);
  assert.match(install, /disabled-notioncode/);
  assert.match(install, /not recognized as the legacy NotionCode launcher and was left unchanged/);
});
