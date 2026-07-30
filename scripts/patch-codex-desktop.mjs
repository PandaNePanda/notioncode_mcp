#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const UI_GATE_ORIGINAL = "d=a&&!u&&c!=null&&c?.requirements?.featureRequirements?.fast_mode!==!1";
export const UI_GATE_PATCHED = "d=!u&&(!o||a&&c&&c.requirements?.featureRequirements?.fast_mode!=!1)";
export const REQUEST_GATE_ORIGINAL = "async function FWi(e,t){let n=await MWi(e,t);if(n!==`chatgpt`)return!1;let r=await Y8n(t,{priority:`critical`});return e.query.setData(QE,{authMethod:n,hostId:t},r),r.requirements?.featureRequirements?.fast_mode!==!1}";
export const REQUEST_GATE_PREVIOUS = REQUEST_GATE_ORIGINAL
  .replace("if(n!==`chatgpt`)return!1", "if(n&&n!=`chatgpt`)return!1")
  .replace("e.query.setData(QE,{authMethod:n,hostId:t},r),", "");
export const REQUEST_GATE_PATCHED = REQUEST_GATE_ORIGINAL
  // A user-owned local runtime deliberately has no ChatGPT auth method. Do
  // not issue the critical-priority cloud requirements request in that mode:
  // it cannot succeed, delays the local UI, and can race the healthy local
  // host state into a misleading reconnecting state. Real ChatGPT sessions
  // retain the upstream requirements check; other authenticated providers
  // remain ineligible.
  .replace("if(n!==`chatgpt`)return!1", "if(n==null)return!0;if(n!=`chatgpt`)return!1")
  .replace("e.query.setData(QE,{authMethod:n,hostId:t},r),", "");
export const MODEL_VISIBILITY_ORIGINAL = "let c=[],l=null,u=s&&t!==`amazonBedrock`";
export const MODEL_VISIBILITY_PATCHED = "let c=[],l,u=t&&s&&t!==`amazonBedrock`";
export const CONFIG_WRITE_ORIGINAL = "function t3r(e,t){let n=(0,r3r.c)(5),r=Vo(Q),i=IE(),a;return n[0]!==e||n[1]!==i||n[2]!==t||n[3]!==r?(a=async n=>{let a=$er(n);Rf(`batch-write-config-value`,{hostId:e,edits:[{keyPath:n3r(t),value:a,mergeStrategy:`upsert`}],filePath:null,expectedVersion:null,reloadUserConfig:!0}),r.set(Wtr,e,etr(n)),await Promise.all([i([`config`]),i([...GWr,e,null])]),await r.query.fetch(bM,{hostId:e})},n[0]=e,n[1]=i,n[2]=t,n[3]=r,n[4]=a):a=n[4],a}";
export const CONFIG_WRITE_PATCHED = CONFIG_WRITE_ORIGINAL
  .replace("a=async n=>{let a=$er(n);Rf(", "a=async n=>{await Rf(")
  .replace("value:a,mergeStrategy", "value:$er(n),mergeStrategy");
export const FAST_DESCRIPTION_ORIGINAL = "1.5x speed, increased usage";
export const FAST_DESCRIPTION_PATCHED = "Requests priority tier";
export const ULTRAFAST_DESCRIPTION_ORIGINAL = "The fastest available responses for latency-sensitive work";
export const ULTRAFAST_DESCRIPTION_PREVIOUS = "Requests ultrafast tier if supported";
export const ULTRAFAST_DESCRIPTION_PATCHED = "Coming soon; enabled only when supported";
export const SHOW_ULTRA_SLIDER_DEFAULT_ORIGINAL = "default:!1,description:`Whether Ultra appears in the model picker slider`";
export const SHOW_ULTRA_SLIDER_DEFAULT_PATCHED = "default:!0,description:`Whether Ultra appears in the model picker slider`";
export const REASONING_RESET_ORIGINAL = "!t&&(i===`max`||i===`ultra`)&&await IJr(e,n,r,i),await Sp(e,Mu.enabledReasoningEfforts,o)";
export const REASONING_RESET_PATCHED = "await Sp(e,Mu.enabledReasoningEfforts,o)";

export const KNOWN_DESKTOPS = new Map([
  ["26.721.11231.0", {
    packageVersion: "26.721.81911",
    buildNumber: "5973",
    rendererPath: "webview/assets/app-initial-CHAIly1j.js",
  }],
]);

const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function count(bytes, needle) {
  let found = 0;
  for (let at = 0; (at = bytes.indexOf(needle, at)) !== -1; at += needle.length) found += 1;
  return found;
}

function parseAsar(archive) {
  if (archive.length < 17 || archive.readUInt32LE(0) !== 4) throw new Error("Unsupported ASAR header prelude.");
  const headerSize = archive.readUInt32LE(4);
  const jsonLength = archive.readUInt32LE(12);
  const jsonStart = 16;
  const dataStart = 8 + headerSize;
  if (jsonStart + jsonLength > dataStart || dataStart > archive.length) throw new Error("Invalid ASAR header sizes.");
  const jsonText = archive.subarray(jsonStart, jsonStart + jsonLength).toString("utf8");
  const header = JSON.parse(jsonText);
  if (JSON.stringify(header) !== jsonText) throw new Error("ASAR header is not canonical JSON.");
  return { dataStart, header, jsonLength, jsonStart };
}

function getEntry(header, entryPath) {
  let entry = header;
  for (const part of entryPath.split("/")) {
    entry = entry?.files?.[part];
    if (!entry) throw new Error(`ASAR entry is missing: ${entryPath}`);
  }
  if (!Number.isSafeInteger(Number(entry.offset)) || !Number.isSafeInteger(entry.size)) {
    throw new Error(`ASAR entry has invalid size or offset: ${entryPath}`);
  }
  return entry;
}

function readEntry(archive, parsed, entryPath) {
  const entry = getEntry(parsed.header, entryPath);
  const start = parsed.dataStart + Number(entry.offset);
  const end = start + entry.size;
  if (start < parsed.dataStart || end > archive.length) throw new Error(`ASAR entry is outside the archive: ${entryPath}`);
  return { bytes: archive.subarray(start, end), entry, start };
}

function makeIntegrity(bytes, blockSize) {
  const blocks = [];
  for (let at = 0; at < bytes.length; at += blockSize) blocks.push(digest(bytes.subarray(at, Math.min(at + blockSize, bytes.length))));
  return { hash: digest(bytes), blocks };
}

function verifyIntegrity(bytes, entry, entryPath) {
  const integrity = entry.integrity;
  if (integrity?.algorithm !== "SHA256" || !Number.isSafeInteger(integrity.blockSize) || integrity.blockSize <= 0 || !Array.isArray(integrity.blocks)) {
    throw new Error(`Unsupported ASAR integrity metadata: ${entryPath}`);
  }
  const actual = makeIntegrity(bytes, integrity.blockSize);
  if (actual.hash !== integrity.hash || actual.blocks.length !== integrity.blocks.length || actual.blocks.some((value, index) => value !== integrity.blocks[index])) {
    throw new Error(`ASAR integrity verification failed: ${entryPath}`);
  }
}

function inspectMetadata(archive, parsed, expected) {
  const file = readEntry(archive, parsed, "package.json");
  verifyIntegrity(file.bytes, file.entry, "package.json");
  const metadata = JSON.parse(file.bytes.toString("utf8"));
  if (metadata.name !== "openai-codex-electron" || metadata.version !== expected.packageVersion || String(metadata.codexBuildNumber) !== expected.buildNumber) {
    throw new Error(`Unsupported Codex Desktop metadata: ${metadata.name ?? "unknown"} ${metadata.version ?? "unknown"} build ${metadata.codexBuildNumber ?? "unknown"}.`);
  }
  return metadata;
}

function padded(replacement, size) {
  const bytes = Buffer.from(replacement);
  if (bytes.length > size) throw new Error("A Codex Desktop replacement is too large.");
  return Buffer.concat([bytes, Buffer.alloc(size - bytes.length, 0x20)]);
}

function replaceExactlyOnce(bytes, original, replacement) {
  const first = bytes.indexOf(original);
  if (first === -1 || bytes.indexOf(original, first + 1) !== -1) throw new Error("Expected exactly one Codex Desktop patch target.");
  replacement.copy(bytes, first);
}

function replaceExactly(bytes, original, replacement, expectedCount) {
  let found = 0;
  for (let at = bytes.indexOf(original); at !== -1; at = bytes.indexOf(original, at + original.length)) {
    replacement.copy(bytes, at);
    found += 1;
  }
  if (found !== expectedCount) throw new Error(`Expected ${expectedCount} Codex Desktop patch targets, found ${found}.`);
}

export function patchArchiveBuffer(input, expected) {
  const archive = Buffer.from(input);
  const parsed = parseAsar(archive);
  const metadata = inspectMetadata(archive, parsed, expected);
  const renderer = readEntry(archive, parsed, expected.rendererPath);
  verifyIntegrity(renderer.bytes, renderer.entry, expected.rendererPath);

  const targets = [
    {
      original: Buffer.from(UI_GATE_ORIGINAL),
      replacement: padded(UI_GATE_PATCHED, Buffer.byteLength(UI_GATE_ORIGINAL)),
      originalCount: 1,
      patchedCount: 1,
    },
    {
      original: Buffer.from(REQUEST_GATE_ORIGINAL),
      replacement: padded(REQUEST_GATE_PATCHED, Buffer.byteLength(REQUEST_GATE_ORIGINAL)),
      legacy: [padded(REQUEST_GATE_PREVIOUS, Buffer.byteLength(REQUEST_GATE_ORIGINAL))],
      originalCount: 1,
      patchedCount: 1,
    },
    {
      original: Buffer.from(MODEL_VISIBILITY_ORIGINAL),
      replacement: padded(MODEL_VISIBILITY_PATCHED, Buffer.byteLength(MODEL_VISIBILITY_ORIGINAL)),
      originalCount: 1,
      patchedCount: 1,
    },
    {
      original: Buffer.from(CONFIG_WRITE_ORIGINAL),
      replacement: padded(CONFIG_WRITE_PATCHED, Buffer.byteLength(CONFIG_WRITE_ORIGINAL)),
      originalCount: 1,
      patchedCount: 1,
    },
    {
      original: Buffer.from(FAST_DESCRIPTION_ORIGINAL),
      replacement: padded(FAST_DESCRIPTION_PATCHED, Buffer.byteLength(FAST_DESCRIPTION_ORIGINAL)),
      originalCount: 1,
      patchedCount: 1,
    },
    {
      original: Buffer.from(ULTRAFAST_DESCRIPTION_ORIGINAL),
      replacement: padded(ULTRAFAST_DESCRIPTION_PATCHED, Buffer.byteLength(ULTRAFAST_DESCRIPTION_ORIGINAL)),
      legacy: [padded(ULTRAFAST_DESCRIPTION_PREVIOUS, Buffer.byteLength(ULTRAFAST_DESCRIPTION_ORIGINAL))],
      originalCount: 1,
      patchedCount: 1,
    },
    {
      original: Buffer.from(SHOW_ULTRA_SLIDER_DEFAULT_ORIGINAL),
      replacement: padded(SHOW_ULTRA_SLIDER_DEFAULT_PATCHED, Buffer.byteLength(SHOW_ULTRA_SLIDER_DEFAULT_ORIGINAL)),
      originalCount: 1,
      patchedCount: 1,
    },
    {
      original: Buffer.from(REASONING_RESET_ORIGINAL),
      replacement: padded(REASONING_RESET_PATCHED, Buffer.byteLength(REASONING_RESET_ORIGINAL)),
      originalCount: 1,
      patchedCount: 1,
    },
  ];
  const oldCounts = targets.map(({ original }) => count(renderer.bytes, original));
  const newCounts = targets.map(({ replacement }) => count(renderer.bytes, replacement));
  const legacyCounts = targets.map(({ legacy = [] }) => legacy.map((value) => count(renderer.bytes, value)));
  const targetStates = oldCounts.map((oldCount, index) => {
    if (oldCount === targets[index].originalCount && newCounts[index] === 0) return "original";
    if (oldCount === 0 && newCounts[index] === targets[index].patchedCount) return "patched";
    if (
      oldCount === 0
      && newCounts[index] === 0
      && legacyCounts[index].reduce((sum, value) => sum + value, 0) === targets[index].patchedCount
    ) return "legacy";
    return null;
  });
  if (targetStates.some((value) => value === null)) {
    throw new Error(`Unknown or ambiguous Codex Desktop renderer patterns (original=${oldCounts}, patched=${newCounts}).`);
  }
  const status = targetStates.every((value) => value === "patched") ? "already-patched" : "patched";

  if (status === "patched") {
    const mutable = archive.subarray(renderer.start, renderer.start + renderer.entry.size);
    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index];
      if (targetStates[index] === "original") {
        if (target.originalCount === 1) replaceExactlyOnce(mutable, target.original, target.replacement);
        else replaceExactly(mutable, target.original, target.replacement, target.originalCount);
      } else if (targetStates[index] === "legacy") {
        const legacy = target.legacy.find((value) => count(mutable, value) === target.patchedCount);
        if (!legacy) throw new Error("Expected exactly one legacy Codex Desktop patch target.");
        replaceExactly(mutable, legacy, target.replacement, target.patchedCount);
      }
    }
    const integrity = makeIntegrity(mutable, renderer.entry.integrity.blockSize);
    renderer.entry.integrity.hash = integrity.hash;
    renderer.entry.integrity.blocks = integrity.blocks;
    const headerBytes = Buffer.from(JSON.stringify(parsed.header));
    if (headerBytes.length !== parsed.jsonLength) throw new Error("ASAR integrity update changed the header size.");
    headerBytes.copy(archive, parsed.jsonStart);
  }

  const verified = parseAsar(archive);
  const verifiedRenderer = readEntry(archive, verified, expected.rendererPath);
  verifyIntegrity(verifiedRenderer.bytes, verifiedRenderer.entry, expected.rendererPath);
  inspectMetadata(archive, verified, expected);
  if (archive.length !== input.length) throw new Error("Codex Desktop archive size changed unexpectedly.");
  return { archive, status, packageVersion: metadata.version, buildNumber: String(metadata.codexBuildNumber), rendererPath: expected.rendererPath };
}

function isInside(base, candidate) {
  const relative = path.relative(path.resolve(base), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeWrite(filename, bytes, mode) {
  const temporary = `${filename}.notioncode-${process.pid}-${crypto.randomBytes(5).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temporary, bytes, { mode });
    fs.copyFileSync(temporary, filename);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function patchDesktopArchive(archivePath, expected, { dryRun = false, writeArchive = safeWrite } = {}) {
  const original = fs.readFileSync(archivePath);
  const result = patchArchiveBuffer(original, expected);
  const originalHash = digest(original);
  const patchedHash = digest(result.archive);
  const backupPath = `${archivePath}.notioncode-original.bak`;
  if (result.status === "patched" && !dryRun) {
    const mode = fs.statSync(archivePath).mode;
    if (fs.existsSync(backupPath)) {
      if (patchArchiveBuffer(fs.readFileSync(backupPath), expected).status !== "patched") throw new Error(`Existing backup is not a verified original: ${backupPath}`);
    } else safeWrite(backupPath, original, mode);
    try {
      writeArchive(archivePath, result.archive, mode);
      const written = fs.readFileSync(archivePath);
      if (written.length !== original.length || digest(written) !== patchedHash || patchArchiveBuffer(written, expected).status !== "already-patched") {
        throw new Error("Post-write Codex Desktop archive verification failed.");
      }
    } catch (error) {
      fs.writeFileSync(archivePath, original, { mode });
      throw error;
    }
  }
  return { ...result, archive: undefined, archivePath, backupPath, dryRun, originalHash, patchedHash, sizeBytes: original.length };
}

export function patchInstalledDesktop({ desktopRoot, dryRun = false, localAppData = process.env.LOCALAPPDATA, platform = process.platform } = {}) {
  if (platform !== "win32") return { runtimes: 0, patched: 0, alreadyPatched: 0, skipped: true, results: [] };
  if (!localAppData) throw new Error("LOCALAPPDATA is required for the Codex Desktop patch.");
  const allowedRoot = path.join(localAppData, "NotionCode", "CodexDesktop");
  const root = path.resolve(desktopRoot ?? allowedRoot);
  if (!isInside(allowedRoot, root)) throw new Error("Refusing to patch outside the user-owned NotionCode Codex Desktop runtime.");
  if (!fs.existsSync(root)) return { runtimes: 0, patched: 0, alreadyPatched: 0, skipped: false, results: [] };
  const results = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const archivePath = path.join(root, entry.name, "app", "resources", "app.asar");
    if (!fs.existsSync(archivePath)) continue;
    const expected = KNOWN_DESKTOPS.get(entry.name);
    if (!expected) throw new Error(`Unsupported user-owned Codex Desktop version: ${entry.name}`);
    results.push(patchDesktopArchive(archivePath, expected, { dryRun }));
  }
  return {
    runtimes: results.length,
    patched: results.filter((value) => value.status === "patched").length,
    alreadyPatched: results.filter((value) => value.status === "already-patched").length,
    skipped: false,
    results,
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dryRun = process.argv.includes("--dry-run");
  const root = process.argv.slice(2).find((value) => !value.startsWith("--"));
  try {
    const summary = patchInstalledDesktop({ desktopRoot: root, dryRun });
    if (summary.skipped) console.log("Codex Desktop compatibility patch is Windows-only; skipped.");
    else if (summary.runtimes === 0) console.log("User-owned Codex Desktop runtime is not installed; compatibility patch skipped.");
    else {
      console.log(`Codex Desktop speed-tier compatibility: ${summary.patched} ${dryRun ? "would be patched" : "patched"}, ${summary.alreadyPatched} already patched.`);
      for (const result of summary.results) console.log(`${result.packageVersion} build ${result.buildNumber}: ${result.status}; ${result.sizeBytes} bytes; ${result.originalHash} -> ${result.patchedHash}`);
    }
  } catch (error) {
    console.error(`Codex Desktop compatibility patch failed: ${error.message}`);
    process.exitCode = 1;
  }
}
