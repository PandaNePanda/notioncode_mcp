#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const [
  stateDirectory,
  codexConfigPath,
  catalogTemplatePath,
  openCodeConfigPath,
  requestedProfile = "",
] = process.argv.slice(2);

if (!stateDirectory || !codexConfigPath || !catalogTemplatePath || !openCodeConfigPath) {
  throw new Error(
    "usage: apply-token-profile.mjs <state-dir> <codex-config> <catalog-template> <opencode-config> [safe|extreme]",
  );
}

const profiles = Object.freeze({
  safe: Object.freeze({
    label: "Safe",
    contextWindow: 100000,
    autoCompactTokenLimit: 60000,
  }),
  extreme: Object.freeze({
    label: "Extreme",
    contextWindow: 256000,
    autoCompactTokenLimit: 140000,
  }),
});

const profilePath = path.join(stateDirectory, "token-profile");
fs.mkdirSync(stateDirectory, { recursive: true });

let profileName = requestedProfile.trim().toLowerCase();
if (!profileName && fs.existsSync(profilePath)) {
  profileName = fs.readFileSync(profilePath, "utf8").trim().toLowerCase();
}
if (!profileName) profileName = "extreme";
if (!(profileName in profiles)) {
  throw new Error(`Unknown token profile: ${profileName}`);
}

const profile = profiles[profileName];
fs.writeFileSync(profilePath, `${profileName}\n`, "utf8");
if (process.platform !== "win32") fs.chmodSync(profilePath, 0o600);

function replaceRequired(content, pattern, replacement, label) {
  if (!pattern.test(content)) throw new Error(`Missing ${label} in ${codexConfigPath}`);
  return content.replace(pattern, replacement);
}

const catalogOutputPath = path.join(stateDirectory, "codex-models.json");
const portableCatalogPath = catalogOutputPath.replaceAll("\\", "/");
let codexConfig = fs.readFileSync(codexConfigPath, "utf8");
codexConfig = replaceRequired(
  codexConfig,
  /^model_context_window\s*=\s*\d+\s*$/m,
  `model_context_window = ${profile.contextWindow}`,
  "model_context_window",
);
codexConfig = replaceRequired(
  codexConfig,
  /^model_auto_compact_token_limit\s*=\s*\d+\s*$/m,
  `model_auto_compact_token_limit = ${profile.autoCompactTokenLimit}`,
  "model_auto_compact_token_limit",
);
codexConfig = replaceRequired(
  codexConfig,
  /^model_catalog_json\s*=.*$/m,
  `model_catalog_json = ${JSON.stringify(portableCatalogPath)}`,
  "model_catalog_json",
);
fs.writeFileSync(codexConfigPath, codexConfig, "utf8");
if (process.platform !== "win32") fs.chmodSync(codexConfigPath, 0o600);

const catalog = JSON.parse(fs.readFileSync(catalogTemplatePath, "utf8"));
let catalogUpdates = 0;
function updateCatalog(value) {
  if (Array.isArray(value)) {
    for (const item of value) updateCatalog(item);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "context_window" || key === "max_context_window") {
      value[key] = profile.contextWindow;
      catalogUpdates += 1;
    } else if (key === "auto_compact_token_limit") {
      value[key] = profile.autoCompactTokenLimit;
      catalogUpdates += 1;
    } else {
      updateCatalog(child);
    }
  }
}
updateCatalog(catalog);
if (catalogUpdates === 0) throw new Error("Model catalog contains no token limits");
fs.writeFileSync(catalogOutputPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
if (process.platform !== "win32") fs.chmodSync(catalogOutputPath, 0o600);

let openCodeConfig = fs.readFileSync(openCodeConfigPath, "utf8");
let openCodeUpdates = 0;
openCodeConfig = openCodeConfig.replace(/("context"\s*:\s*)\d+/g, (_match, prefix) => {
  openCodeUpdates += 1;
  return `${prefix}${profile.contextWindow}`;
});
if (openCodeUpdates === 0) throw new Error("OpenCode config contains no context limits");
fs.writeFileSync(openCodeConfigPath, openCodeConfig, "utf8");

console.log(
  `Token profile applied: ${profile.label} (${profile.contextWindow.toLocaleString("en-US")} context, ${profile.autoCompactTokenLimit.toLocaleString("en-US")} auto-compact)`,
);
