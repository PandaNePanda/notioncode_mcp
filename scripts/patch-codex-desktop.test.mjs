#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CONFIG_WRITE_ORIGINAL,
  CONFIG_WRITE_PATCHED,
  FAST_DESCRIPTION_ORIGINAL,
  FAST_DESCRIPTION_PATCHED,
  KNOWN_DESKTOPS,
  MODEL_VISIBILITY_ORIGINAL,
  MODEL_VISIBILITY_PATCHED,
  REASONING_RESET_ORIGINAL,
  REASONING_RESET_PATCHED,
  REQUEST_GATE_ORIGINAL,
  REQUEST_GATE_PREVIOUS,
  REQUEST_GATE_PATCHED,
  SHOW_ULTRA_SLIDER_DEFAULT_ORIGINAL,
  SHOW_ULTRA_SLIDER_DEFAULT_PATCHED,
  UI_GATE_ORIGINAL,
  UI_GATE_PATCHED,
  ULTRAFAST_DESCRIPTION_ORIGINAL,
  ULTRAFAST_DESCRIPTION_PREVIOUS,
  ULTRAFAST_DESCRIPTION_PATCHED,
  patchArchiveBuffer,
  patchDesktopArchive,
  patchInstalledDesktop,
} from "./patch-codex-desktop.mjs";

const expected = KNOWN_DESKTOPS.get("26.721.11231.0");
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const align4 = (value) => (value + 3) & ~3;

function integrity(bytes, blockSize = 32) {
  const blocks = [];
  for (let at = 0; at < bytes.length; at += blockSize) {
    blocks.push(hash(bytes.subarray(at, Math.min(at + blockSize, bytes.length))));
  }
  return { algorithm: "SHA256", hash: hash(bytes), blockSize, blocks };
}

function makeAsar({
  buildNumber = expected.buildNumber,
  packageVersion = expected.packageVersion,
  renderer = `prefix;${UI_GATE_ORIGINAL};middle;${REQUEST_GATE_ORIGINAL};models;${MODEL_VISIBILITY_ORIGINAL};config;${CONFIG_WRITE_ORIGINAL};fast;${FAST_DESCRIPTION_ORIGINAL};ultrafast;${ULTRAFAST_DESCRIPTION_ORIGINAL};slider;${SHOW_ULTRA_SLIDER_DEFAULT_ORIGINAL};reset;${REASONING_RESET_ORIGINAL};suffix`,
} = {}) {
  const packageBytes = Buffer.from(JSON.stringify({
    name: "openai-codex-electron",
    version: packageVersion,
    codexBuildNumber: buildNumber,
  }));
  const rendererBytes = Buffer.from(renderer);
  const header = {
    files: {
      "package.json": { size: packageBytes.length, offset: "0", integrity: integrity(packageBytes) },
      webview: { files: { assets: { files: {
        "app-initial-CHAIly1j.js": {
          size: rendererBytes.length,
          offset: String(packageBytes.length),
          integrity: integrity(rendererBytes),
        },
      } } } },
    },
  };
  const json = Buffer.from(JSON.stringify(header));
  const payloadSize = 4 + json.length + 1;
  const headerSize = 4 + align4(payloadSize);
  const prelude = Buffer.alloc(8 + headerSize);
  prelude.writeUInt32LE(4, 0);
  prelude.writeUInt32LE(headerSize, 4);
  prelude.writeUInt32LE(payloadSize, 8);
  prelude.writeUInt32LE(json.length, 12);
  json.copy(prelude, 16);
  return Buffer.concat([prelude, packageBytes, rendererBytes]);
}

test("patches UI, request, visibility, descriptions, slider defaults, and awaited service-tier persistence while preserving exact ASAR size", () => {
  const original = makeAsar();
  const result = patchArchiveBuffer(original, expected);
  const text = result.archive.toString("utf8");
  assert.equal(result.status, "patched");
  assert.equal(result.archive.length, original.length);
  assert.equal(text.includes(UI_GATE_ORIGINAL), false);
  assert.equal(text.includes(REQUEST_GATE_ORIGINAL), false);
  assert.equal(text.includes(MODEL_VISIBILITY_ORIGINAL), false);
  assert.equal(text.includes(CONFIG_WRITE_ORIGINAL), false);
  assert.equal(text.includes(FAST_DESCRIPTION_ORIGINAL), false);
  assert.equal(text.includes(ULTRAFAST_DESCRIPTION_ORIGINAL), false);
  assert.equal(text.includes(SHOW_ULTRA_SLIDER_DEFAULT_ORIGINAL), false);
  assert.equal(text.includes(REASONING_RESET_ORIGINAL), false);
  assert.equal(text.includes(UI_GATE_PATCHED), true);
  assert.equal(text.includes(REQUEST_GATE_PATCHED), true);
  assert.equal(text.includes(MODEL_VISIBILITY_PATCHED), true);
  assert.equal(text.includes(CONFIG_WRITE_PATCHED), true);
  assert.equal(text.includes(FAST_DESCRIPTION_PATCHED), true);
  assert.equal(text.includes(ULTRAFAST_DESCRIPTION_PATCHED), true);
  assert.equal(text.split(SHOW_ULTRA_SLIDER_DEFAULT_PATCHED).length - 1, 1);
  assert.equal(text.includes(REASONING_RESET_PATCHED), true);
});

test("upgrades the prior Fast-only desktop patch without rewriting existing gates", () => {
  const patchedUi = UI_GATE_PATCHED.padEnd(UI_GATE_ORIGINAL.length, " ");
  const patchedRequest = REQUEST_GATE_PREVIOUS.padEnd(REQUEST_GATE_ORIGINAL.length, " ");
  const legacy = makeAsar({
    renderer: `${patchedUi};${patchedRequest};${MODEL_VISIBILITY_ORIGINAL};${CONFIG_WRITE_ORIGINAL};${FAST_DESCRIPTION_ORIGINAL};${ULTRAFAST_DESCRIPTION_ORIGINAL};${SHOW_ULTRA_SLIDER_DEFAULT_ORIGINAL};${REASONING_RESET_ORIGINAL}`,
  });
  const result = patchArchiveBuffer(legacy, expected);
  const text = result.archive.toString("utf8");
  assert.equal(result.status, "patched");
  assert.equal(result.archive.length, legacy.length);
  assert.equal(text.includes(patchedUi), true);
  assert.equal(text.includes(patchedRequest), false);
  assert.equal(text.includes(REQUEST_GATE_PATCHED), true);
  assert.equal(text.includes(MODEL_VISIBILITY_ORIGINAL), false);
  assert.equal(text.includes(MODEL_VISIBILITY_PATCHED), true);
  assert.equal(text.includes(CONFIG_WRITE_ORIGINAL), false);
  assert.equal(text.includes(CONFIG_WRITE_PATCHED), true);
  assert.equal(text.includes(REASONING_RESET_PATCHED), true);
});

test("upgrades the prior three-patch desktop archive with awaited service-tier persistence", () => {
  const patchedUi = UI_GATE_PATCHED.padEnd(UI_GATE_ORIGINAL.length, " ");
  const patchedRequest = REQUEST_GATE_PATCHED.padEnd(REQUEST_GATE_ORIGINAL.length, " ");
  const patchedVisibility = MODEL_VISIBILITY_PATCHED.padEnd(MODEL_VISIBILITY_ORIGINAL.length, " ");
  const legacy = makeAsar({
    renderer: `${patchedUi};${patchedRequest};${patchedVisibility};${CONFIG_WRITE_ORIGINAL};${FAST_DESCRIPTION_ORIGINAL};${ULTRAFAST_DESCRIPTION_ORIGINAL};${SHOW_ULTRA_SLIDER_DEFAULT_ORIGINAL};${REASONING_RESET_ORIGINAL}`,
  });
  const result = patchArchiveBuffer(legacy, expected);
  const text = result.archive.toString("utf8");
  assert.equal(result.status, "patched");
  assert.equal(result.archive.length, legacy.length);
  assert.equal(text.includes(patchedUi), true);
  assert.equal(text.includes(patchedRequest), true);
  assert.equal(text.includes(patchedVisibility), true);
  assert.equal(text.includes(CONFIG_WRITE_ORIGINAL), false);
  assert.equal(text.includes(CONFIG_WRITE_PATCHED), true);
  assert.equal(text.includes(REASONING_RESET_PATCHED), true);
});

test("upgrades the previously patched Ultrafast description", () => {
  const patchedUi = UI_GATE_PATCHED.padEnd(UI_GATE_ORIGINAL.length, " ");
  const patchedRequest = REQUEST_GATE_PATCHED.padEnd(REQUEST_GATE_ORIGINAL.length, " ");
  const patchedVisibility = MODEL_VISIBILITY_PATCHED.padEnd(MODEL_VISIBILITY_ORIGINAL.length, " ");
  const patchedConfig = CONFIG_WRITE_PATCHED.padEnd(CONFIG_WRITE_ORIGINAL.length, " ");
  const patchedFast = FAST_DESCRIPTION_PATCHED.padEnd(FAST_DESCRIPTION_ORIGINAL.length, " ");
  const previousUltrafast = ULTRAFAST_DESCRIPTION_PREVIOUS.padEnd(ULTRAFAST_DESCRIPTION_ORIGINAL.length, " ");
  const patchedSlider = SHOW_ULTRA_SLIDER_DEFAULT_PATCHED.padEnd(SHOW_ULTRA_SLIDER_DEFAULT_ORIGINAL.length, " ");
  const patchedReasoning = REASONING_RESET_PATCHED.padEnd(REASONING_RESET_ORIGINAL.length, " ");
  const legacy = makeAsar({
    renderer: `${patchedUi};${patchedRequest};${patchedVisibility};${patchedConfig};${patchedFast};${previousUltrafast};${patchedSlider};${patchedReasoning}`,
  });
  const result = patchArchiveBuffer(legacy, expected);
  const text = result.archive.toString("utf8");
  assert.equal(result.status, "patched");
  assert.equal(result.archive.length, legacy.length);
  assert.equal(text.includes(ULTRAFAST_DESCRIPTION_PREVIOUS), false);
  assert.equal(text.includes(ULTRAFAST_DESCRIPTION_PATCHED), true);
});

test("awaits the service-tier config write before invalidating and refetching settings", () => {
  assert.ok(CONFIG_WRITE_PATCHED.length <= CONFIG_WRITE_ORIGINAL.length);
  assert.equal(CONFIG_WRITE_PATCHED.includes("let a=$er(n);Rf("), false);
  assert.equal(CONFIG_WRITE_PATCHED.includes("await Rf(`batch-write-config-value`"), true);
  assert.ok(CONFIG_WRITE_PATCHED.indexOf("await Rf(`batch-write-config-value`") < CONFIG_WRITE_PATCHED.indexOf("await Promise.all"));
  assert.ok(CONFIG_WRITE_PATCHED.indexOf("await Promise.all") < CONFIG_WRITE_PATCHED.indexOf("await r.query.fetch"));
});

test("bypasses the remote model allowlist only for null local authentication", () => {
  const getUseAllowlist = new Function("s", "t", `${MODEL_VISIBILITY_PATCHED};return Boolean(u);`);
  assert.equal(getUseAllowlist(true, null), false);
  assert.equal(getUseAllowlist(true, "chatgpt"), true);
  assert.equal(getUseAllowlist(true, "copilot"), true);
  assert.equal(getUseAllowlist(true, "amazonBedrock"), false);
});

test("never polls cloud requirements for the unauthenticated local runtime", async () => {
  let requirementCalls = 0;
  const getAuthMethod = async (_query, hostId) => hostId;
  const getRequirements = async () => {
    requirementCalls += 1;
    return { requirements: { featureRequirements: { fast_mode: true } } };
  };
  const requestGate = new Function(
    "MWi",
    "Y8n",
    "QE",
    `${REQUEST_GATE_PATCHED};return FWi;`,
  )(getAuthMethod, getRequirements, Symbol("requirements"));

  assert.equal(await requestGate({}, null), true);
  assert.equal(requirementCalls, 0);
  assert.equal(await requestGate({}, "copilot"), false);
  assert.equal(requirementCalls, 0);
  assert.equal(await requestGate({}, "chatgpt"), true);
  assert.equal(requirementCalls, 1);
  assert.ok(REQUEST_GATE_PATCHED.indexOf("if(n==null)return!0") < REQUEST_GATE_PATCHED.indexOf("Y8n("));
  assert.equal(REQUEST_GATE_PATCHED.includes("query.setData"), false);
});

test("is idempotent and verifies updated integrity hashes", () => {
  const first = patchArchiveBuffer(makeAsar(), expected);
  const second = patchArchiveBuffer(first.archive, expected);
  assert.equal(second.status, "already-patched");
  assert.deepEqual(second.archive, first.archive);
});

test("refuses missing, ambiguous, and mixed renderer targets", () => {
  assert.throws(() => patchArchiveBuffer(makeAsar({ renderer: "no targets" }), expected), /Unknown or ambiguous/);
  assert.throws(
    () => patchArchiveBuffer(makeAsar({ renderer: `${UI_GATE_ORIGINAL}${UI_GATE_ORIGINAL}${REQUEST_GATE_ORIGINAL}${MODEL_VISIBILITY_ORIGINAL}${CONFIG_WRITE_ORIGINAL}` }), expected),
    /Unknown or ambiguous/,
  );
  const patchedUi = UI_GATE_PATCHED.padEnd(UI_GATE_ORIGINAL.length, " ");
  assert.throws(
    () => patchArchiveBuffer(makeAsar({ renderer: `${patchedUi}${REQUEST_GATE_ORIGINAL}${MODEL_VISIBILITY_ORIGINAL}${CONFIG_WRITE_ORIGINAL}` }), expected),
    /Unknown or ambiguous/,
  );
});

test("refuses unknown package versions and builds", () => {
  assert.throws(() => patchArchiveBuffer(makeAsar({ packageVersion: "99.0.0" }), expected), /Unsupported Codex Desktop metadata/);
  assert.throws(() => patchArchiveBuffer(makeAsar({ buildNumber: "9999" }), expected), /Unsupported Codex Desktop metadata/);
});

test("creates a verified original backup before replacement", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "notioncode-desktop-"));
  try {
    const archive = path.join(root, "app.asar");
    const original = makeAsar();
    fs.writeFileSync(archive, original);
    const result = patchDesktopArchive(archive, expected);
    assert.equal(result.status, "patched");
    assert.deepEqual(fs.readFileSync(`${archive}.notioncode-original.bak`), original);
    assert.equal(patchArchiveBuffer(fs.readFileSync(archive), expected).status, "already-patched");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("restores the original archive after a failed final write", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "notioncode-desktop-"));
  try {
    const archive = path.join(root, "app.asar");
    const original = makeAsar();
    fs.writeFileSync(archive, original);
    assert.throws(
      () => patchDesktopArchive(archive, expected, {
        writeArchive(filename) {
          fs.writeFileSync(filename, "corrupt");
          throw new Error("simulated failure");
        },
      }),
      /simulated failure/,
    );
    assert.deepEqual(fs.readFileSync(archive), original);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("patches only a known user-owned Windows runtime", () => {
  const localAppData = fs.mkdtempSync(path.join(os.tmpdir(), "notioncode-localappdata-"));
  try {
    const desktopRoot = path.join(localAppData, "NotionCode", "CodexDesktop");
    const resources = path.join(desktopRoot, "26.721.11231.0", "app", "resources");
    fs.mkdirSync(resources, { recursive: true });
    fs.writeFileSync(path.join(resources, "app.asar"), makeAsar());
    const summary = patchInstalledDesktop({ desktopRoot, localAppData, platform: "win32" });
    assert.equal(summary.runtimes, 1);
    assert.equal(summary.patched, 1);
    assert.throws(
      () => patchInstalledDesktop({ desktopRoot: path.join(localAppData, "outside"), localAppData, platform: "win32" }),
      /outside the user-owned/,
    );
  } finally {
    fs.rmSync(localAppData, { recursive: true, force: true });
  }
});

test("refuses unknown user-owned runtime versions without mutation", () => {
  const localAppData = fs.mkdtempSync(path.join(os.tmpdir(), "notioncode-localappdata-"));
  try {
    const desktopRoot = path.join(localAppData, "NotionCode", "CodexDesktop");
    const resources = path.join(desktopRoot, "99.0.0", "app", "resources");
    fs.mkdirSync(resources, { recursive: true });
    const archive = path.join(resources, "app.asar");
    const original = makeAsar();
    fs.writeFileSync(archive, original);
    assert.throws(() => patchInstalledDesktop({ desktopRoot, localAppData, platform: "win32" }), /Unsupported user-owned/);
    assert.deepEqual(fs.readFileSync(archive), original);
  } finally {
    fs.rmSync(localAppData, { recursive: true, force: true });
  }
});
