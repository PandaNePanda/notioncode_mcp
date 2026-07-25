#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { patchBundle, patchInstalledExtensions } from "./patch-codex-webview.mjs";

const fixture = 'function filter(){return {models:c,defaultModel:l,hasModelSupportingMaxReasoningEffort:d,hasModelSupportingUltraReasoningEffort:f}}';

test("adds Opus to the Codex model filter once", () => {
  const first = patchBundle(fixture);
  assert.equal(first.status, "patched");
  assert.match(first.content, /notioncode-opus-5-picker/);
  assert.match(first.content, /model:"opus-5"/);
  assert.equal((first.content.match(/function filter/g) || []).length, 1);

  const second = patchBundle(first.content);
  assert.equal(second.status, "already-patched");
  assert.equal(second.content, first.content);
});

test("repairs output duplicated by the legacy patcher", () => {
  const legacy = `${fixture}{models:(()=>{/* notioncode-opus-5-picker */})()}${fixture}`;
  const result = patchBundle(legacy);
  assert.equal(result.status, "patched");
  assert.equal((result.content.match(/function filter/g) || []).length, 1);
  assert.equal((result.content.match(/notioncode-opus-5-picker/g) || []).length, 1);
});

test("lists Codex history from every model provider", () => {
  const historyFixture = "sendRequest('thread/list',{modelProviders:null});sendRequest('thread/list',{modelProviders:null});";
  const first = patchBundle(historyFixture);
  assert.equal(first.status, "patched");
  assert.equal((first.content.match(/notioncode-all-history-providers/g) || []).length, 2);
  assert.equal((first.content.match(/modelProviders:\/\* notioncode-all-history-providers \*\/\[\]/g) || []).length, 2);

  const second = patchBundle(first.content);
  assert.equal(second.status, "already-patched");
  assert.equal(second.content, first.content);
});

test("adds the model and history compatibility patches together", () => {
  const result = patchBundle(`${fixture};sendRequest('thread/list',{modelProviders:null})`);
  assert.equal(result.status, "patched");
  assert.match(result.content, /notioncode-opus-5-picker/);
  assert.match(result.content, /notioncode-all-history-providers/);
});

test("patches installed VS Code and VS Code Server extensions", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "notioncode-webview-"));
  try {
    for (const relative of [".vscode/extensions", ".vscode-insiders/extensions", ".vscode-server/extensions"]) {
      const assets = path.join(home, relative, "openai.chatgpt-1.2.3", "webview", "assets");
      fs.mkdirSync(assets, { recursive: true });
      fs.writeFileSync(path.join(assets, "app.js"), fixture);
    }

    assert.deepEqual(patchInstalledExtensions(home), {
      extensions: 3,
      patched: 3,
      alreadyPatched: 0,
      unsupported: 0,
    });
    assert.deepEqual(patchInstalledExtensions(home), {
      extensions: 3,
      patched: 0,
      alreadyPatched: 3,
      unsupported: 0,
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("does not modify an extension with an ambiguous model filter", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "notioncode-webview-"));
  try {
    const assets = path.join(home, ".vscode", "extensions", "openai.chatgpt-1.2.3", "webview", "assets");
    fs.mkdirSync(assets, { recursive: true });
    const ambiguous = `${fixture}${fixture}`;
    const filename = path.join(assets, "app.js");
    fs.writeFileSync(filename, ambiguous);

    assert.deepEqual(patchInstalledExtensions(home), {
      extensions: 1,
      patched: 0,
      alreadyPatched: 0,
      unsupported: 1,
    });
    assert.equal(fs.readFileSync(filename, "utf8"), ambiguous);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("does not partially patch an extension with an unsupported filter asset", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "notioncode-webview-"));
  try {
    const assets = path.join(home, ".vscode", "extensions", "openai.chatgpt-1.2.3", "webview", "assets");
    fs.mkdirSync(assets, { recursive: true });
    const supported = path.join(assets, "supported.js");
    const unsupported = path.join(assets, "unsupported.js");
    fs.writeFileSync(supported, fixture);
    fs.writeFileSync(unsupported, "const x={models:c,defaultModel:l,extra:true,hasModelSupportingMaxReasoningEffort:d};");

    assert.deepEqual(patchInstalledExtensions(home), {
      extensions: 1,
      patched: 0,
      alreadyPatched: 0,
      unsupported: 1,
    });
    assert.equal(fs.readFileSync(supported, "utf8"), fixture);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
