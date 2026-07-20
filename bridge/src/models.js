import { readFile } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson } from "./files.js";

export const DEFAULT_MODEL_ALIASES = Object.freeze({
  "opus-4.8": "ambrosia-tart-high",
  "opus-4.7": "apricot-sorbet-high",
  "opus-4.6": "avocado-froyo-medium",
  "sonnet-4.6": "almond-croissant-low",
  "haiku-4.5": "anthropic-haiku-4.5",
  "gpt-5.2": "oatmeal-cookie",
  "gpt-5.4": "oval-kumquat-medium",
  "gemini-2.5-flash": "vertex-gemini-2.5-flash",
  "gemini-3-flash": "gingerbread",
  "minimax-m2.5": "fireworks-minimax-m2.5",
});

export async function loadUserModelAliases(filePath) {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8"));
    return parsed?.friendly_aliases && typeof parsed.friendly_aliases === "object"
      ? parsed.friendly_aliases
      : {};
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) return {};
    throw error;
  }
}

export async function loadModelAliases(filePath) {
  const user = await loadUserModelAliases(filePath);
  return { ...DEFAULT_MODEL_ALIASES, ...user };
}

export function resolveModel(requested, aliases = DEFAULT_MODEL_ALIASES) {
  const raw = String(requested ?? "").trim();
  if (!raw) return aliases["opus-4.8"];
  if (Object.hasOwn(aliases, raw)) return aliases[raw];
  if (Object.values(aliases).includes(raw)) return raw;

  const normalized = raw.toLowerCase().replace(/-\d{8}$/, "");
  if (Object.hasOwn(aliases, normalized)) return aliases[normalized];
  if (normalized.includes("opus")) return aliases["opus-4.8"];
  if (normalized.includes("sonnet")) return aliases["sonnet-4.6"];
  if (normalized.includes("haiku")) return aliases["haiku-4.5"];
  return raw;
}

export function parseAvailableModels(payload) {
  const entries = Array.isArray(payload) ? payload : payload?.models ?? [];
  const aliases = {};
  for (const entry of entries) {
    if (!entry || entry.enabled === false) continue;
    const internal = entry.id ?? entry.model ?? entry.value;
    const label = entry.modelMessage ?? entry.name ?? entry.label;
    if (typeof internal !== "string" || typeof label !== "string") continue;
    const alias = label
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    if (alias) aliases[alias] = internal;
  }
  return aliases;
}

export async function saveModelAliases(filePath, aliases) {
  const sorted = Object.fromEntries(Object.entries(aliases).sort(([a], [b]) => a.localeCompare(b)));
  await atomicWriteJson(filePath, {
    friendly_aliases: sorted,
    updated_at: new Date().toISOString(),
  });
}

export function modelMapPath(accountHome) {
  return path.join(accountHome, "models.json");
}
