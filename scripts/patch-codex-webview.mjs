#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PATCH_MARKER = "notioncode-opus-5-picker";
const HISTORY_PATCH_MARKER = "notioncode-all-history-providers";
const MODEL_RESULT_PATTERN = /\{\s*models\s*:\s*([A-Za-z_$][\w$]*)\s*,\s*defaultModel\s*:\s*([A-Za-z_$][\w$]*)\s*,\s*hasModelSupportingMaxReasoningEffort\s*:\s*([A-Za-z_$][\w$]*)\s*,\s*hasModelSupportingUltraReasoningEffort\s*:\s*([A-Za-z_$][\w$]*)\s*\}/g;
const KNOWN_FILTER_PATTERN = /models\s*:\s*[A-Za-z_$][\w$]*[\s\S]{0,200}defaultModel\s*:[\s\S]{0,200}hasModelSupportingMaxReasoningEffort/;
const HISTORY_FILTER_PATTERN = /modelProviders:null/g;

export function patchBundle(content) {
  const legacyPatchStart = content.indexOf(`{models:(()=>{/* ${PATCH_MARKER}`);
  if (legacyPatchStart > 0) {
    const original = content.slice(0, legacyPatchStart);
    if (content.endsWith(original)) content = original;
  }

  let patched = false;
  const modelAlreadyPatched = content.includes(PATCH_MARKER);
  if (!modelAlreadyPatched) {
    const matches = [...content.matchAll(MODEL_RESULT_PATTERN)];
    if (matches.length > 1) {
      throw new Error(`Found ${matches.length} Codex model filters in one bundle; refusing an ambiguous patch.`);
    }

    if (matches.length === 1) {
      const match = matches[0];
      const [matched, models, defaultModel, supportsMax, supportsUltra] = match;
      const patchedModels = `(()=>{/* ${PATCH_MARKER} */if(!${models}.some(e=>e.model==="opus-5")){const e=${models}.find(e=>e.model==="gpt-5.6-sol")??${models}.find(e=>e.model==="gpt-5.5")??${models}[0];e&&${models}.push({...e,slug:"opus-5",id:"opus-5",model:"opus-5",display_name:"Opus 5 (Notion)",displayName:"Opus 5 (Notion)",description:"Notion Opus 5 through the local bridge.",isDefault:!1,is_default:!1})}return ${models}})()`;
      const replacement = `{models:${patchedModels},defaultModel:${defaultModel},hasModelSupportingMaxReasoningEffort:${supportsMax},hasModelSupportingUltraReasoningEffort:${supportsUltra}}`;
      const index = match.index;
      content = content.slice(0, index) + replacement + content.slice(index + matched.length);
      patched = true;
    }
  }

  if (!content.includes(HISTORY_PATCH_MARKER) && HISTORY_FILTER_PATTERN.test(content)) {
    HISTORY_FILTER_PATTERN.lastIndex = 0;
    content = content.replaceAll(
      "modelProviders:null",
      `modelProviders:/* ${HISTORY_PATCH_MARKER} */[]`,
    );
    patched = true;
  }

  return {
    content,
    status: patched
      ? "patched"
      : modelAlreadyPatched || content.includes(HISTORY_PATCH_MARKER)
        ? "already-patched"
        : "not-applicable",
  };
}

function extensionRoots(home) {
  const roots = [
    path.join(home, ".vscode", "extensions"),
    path.join(home, ".vscode-insiders", "extensions"),
    path.join(home, ".vscode-server", "extensions"),
    path.join(home, ".vscode-server-insiders", "extensions"),
    path.join(home, ".cursor", "extensions"),
  ];
  if (process.env.VSCODE_EXTENSIONS) roots.push(process.env.VSCODE_EXTENSIONS);
  return [...new Set(roots.map((root) => path.resolve(root)))];
}

export function patchInstalledExtensions(home = os.homedir()) {
  const summary = { extensions: 0, patched: 0, alreadyPatched: 0, unsupported: 0 };
  const pendingWrites = [];

  for (const root of extensionRoots(path.resolve(home))) {
    if (!fs.existsSync(root)) continue;
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith("openai.chatgpt-")) continue;
      const assets = path.join(root, entry.name, "webview", "assets");
      if (!fs.existsSync(assets)) continue;
      summary.extensions += 1;

      let extensionAlreadyPatched = 0;
      let extensionUnsupported = false;
      const extensionWrites = [];
      for (const asset of fs.readdirSync(assets, { withFileTypes: true })) {
        if (!asset.isFile() || !asset.name.endsWith(".js")) continue;
        const filename = path.join(assets, asset.name);
        const original = fs.readFileSync(filename, "utf8");
        const hasKnownFilter = KNOWN_FILTER_PATTERN.test(original);
        let result;
        try {
          result = patchBundle(original);
        } catch {
          extensionUnsupported = true;
          break;
        }
        if (result.status === "patched") {
          extensionWrites.push({ filename, content: result.content });
        } else if (result.status === "already-patched") {
          extensionAlreadyPatched += 1;
        } else if (hasKnownFilter) {
          extensionUnsupported = true;
          break;
        }
      }

      if (extensionUnsupported) {
        summary.unsupported += 1;
        continue;
      }
      summary.alreadyPatched += extensionAlreadyPatched;
      pendingWrites.push(...extensionWrites);
    }
  }

  for (const { filename } of pendingWrites) fs.accessSync(filename, fs.constants.W_OK);
  for (const { filename, content } of pendingWrites) {
    const temporary = `${filename}.notioncode-${process.pid}-${Math.random().toString(16).slice(2)}.tmp`;
    try {
      fs.writeFileSync(temporary, content, {
        encoding: "utf8",
        mode: fs.statSync(filename).mode,
      });
      fs.renameSync(temporary, filename);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  summary.patched = pendingWrites.length;
  return summary;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const summary = patchInstalledExtensions(process.argv[2] || os.homedir());
  if (summary.extensions === 0) {
    console.log("Codex VS Code extension is not installed; webview compatibility patch skipped.");
  } else {
    console.log(`Codex VS Code webview compatibility: ${summary.patched} patched, ${summary.alreadyPatched} already patched, ${summary.unsupported} unsupported.`);
    if (summary.unsupported) {
      console.warn("Warning: an installed Codex extension uses an unknown model filter; Opus picker compatibility was skipped for that version.");
    }
  }
}
