import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import * as z from "zod/v4";

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const DEFAULT_MCP_PORT = 8787;
export const DEFAULT_READ_LIMIT = 500_000;
export const MAX_READ_LIMIT = 2_000_000;
export const DEFAULT_SHELL_TIMEOUT_MS = 30_000;
export const MAX_SHELL_TIMEOUT_MS = 120_000;
export const SHELL_OUTPUT_LIMIT = 2_000_000;
export const DEFAULT_TOOL_OUTPUT_TOKEN_LIMIT = 12_000;
export const MAX_TOOL_OUTPUT_TOKEN_LIMIT = Math.floor(SHELL_OUTPUT_LIMIT / 4);
const TOOL_OUTPUT_CHARS_PER_TOKEN = 4;

function parseEnv(text) {
  const values = {};
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export async function loadRuntimeConfig({
  envPath = path.join(PROJECT_ROOT, "runtime", ".env"),
  env = process.env,
} = {}) {
  let fileValues = {};
  try {
    fileValues = parseEnv(await fs.readFile(envPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new Error("Unable to read Runtime MCP configuration.", { cause: error });
    }
  }

  const secret = env.MCP_PATH_SECRET || fileValues.MCP_PATH_SECRET || "";
  const port = Number(
    env.MCP_PORT || fileValues.MCP_PORT || fileValues.PORT || DEFAULT_MCP_PORT,
  );
  const codeRoot = path.resolve(env.CODE_ROOT || fileValues.CODE_ROOT || PROJECT_ROOT);
  const toolOutputTokenLimit = Number(
    env.TOOL_OUTPUT_TOKEN_LIMIT
      || fileValues.TOOL_OUTPUT_TOKEN_LIMIT
      || DEFAULT_TOOL_OUTPUT_TOKEN_LIMIT,
  );

  if (!secret || secret === "replace-with-a-random-secret" || secret.length < 24) {
    throw new Error("MCP_PATH_SECRET must be configured with at least 24 characters.");
  }
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Runtime MCP port is invalid.");
  }
  if (!Number.isInteger(toolOutputTokenLimit)
    || toolOutputTokenLimit < 1
    || toolOutputTokenLimit > MAX_TOOL_OUTPUT_TOKEN_LIMIT) {
    throw new Error(
      `TOOL_OUTPUT_TOKEN_LIMIT must be an integer between 1 and ${MAX_TOOL_OUTPUT_TOKEN_LIMIT}.`,
    );
  }

  return { secret, port, codeRoot, toolOutputTokenLimit, envPath };
}

export function shellInvocation(command, {
  platform = process.platform,
  configuredShell = process.env.NOTION_SHELL,
} = {}) {
  if (platform === "win32") {
    return {
      executable: configuredShell || "powershell.exe",
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        command,
      ],
    };
  }
  return {
    executable: configuredShell || "/bin/bash",
    args: ["-lc", command],
  };
}

function textResult(text, extra = {}) {
  return { content: [{ type: "text", text: String(text ?? "") }], ...extra };
}

function limitToolResult(result, tokenLimit) {
  const charLimit = tokenLimit * TOOL_OUTPUT_CHARS_PER_TOKEN;
  const textLength = result.content?.reduce(
    (total, item) => total + (item?.type === "text" ? String(item.text ?? "").length : 0),
    0,
  ) ?? 0;
  if (textLength <= charLimit) return result;

  const marker = `\n\n[tool output truncated at approximately ${tokenLimit} tokens]`;
  let remaining = Math.max(0, charLimit - marker.length);
  const content = (result.content ?? []).map((item) => {
    if (item?.type !== "text") return item;
    const text = String(item.text ?? "");
    const kept = text.slice(0, remaining);
    remaining -= kept.length;
    return { ...item, text: kept };
  });
  const lastText = content.findLastIndex((item) => item?.type === "text");
  if (lastText >= 0) content[lastText] = { ...content[lastText], text: `${content[lastText].text}${marker}` };
  else content.push({ type: "text", text: marker.trimStart() });
  return {
    ...result,
    content,
    _meta: { ...(result._meta ?? {}), truncated: true, toolOutputTokenLimit: tokenLimit },
  };
}

const TOOL_DEFINITIONS = Object.freeze([
  {
    name: "list_files",
    title: "List project files",
    description: "List files and directories under CODE_ROOT. Paths are relative to CODE_ROOT.",
    inputSchema: { directory: z.string().optional().default(".") },
  },
  {
    name: "read_file",
    title: "Read a file",
    description: "Read a UTF-8 text file under CODE_ROOT.",
    inputSchema: {
      file_path: z.string(),
      max_bytes: z.number().int().positive().max(MAX_READ_LIMIT).optional().default(DEFAULT_READ_LIMIT),
    },
  },
  {
    name: "write_file",
    title: "Write a file",
    description: "Create or replace a UTF-8 text file under CODE_ROOT. Parent directories are created automatically.",
    inputSchema: { file_path: z.string(), content: z.string() },
  },
  {
    name: "edit_file",
    title: "Edit a file",
    description: "Replace an exact text fragment in a UTF-8 file under CODE_ROOT.",
    inputSchema: {
      file_path: z.string(),
      old_text: z.string(),
      new_text: z.string(),
      replace_all: z.boolean().optional().default(false),
    },
  },
  {
    name: "run_shell",
    title: "Run shell command",
    description: "Run a native shell command on the coding machine. Use cwd relative to CODE_ROOT. This can change the machine.",
    inputSchema: {
      command: z.string(),
      cwd: z.string().optional().default("."),
      timeout_ms: z.number().int().positive().max(MAX_SHELL_TIMEOUT_MS).optional().default(DEFAULT_SHELL_TIMEOUT_MS),
    },
  },
]);

export function createRuntimeToolService({
  root = process.env.CODE_ROOT || os.homedir(),
  env = process.env,
  platform = process.platform,
  toolOutputTokenLimit = Number(
    env.TOOL_OUTPUT_TOKEN_LIMIT || DEFAULT_TOOL_OUTPUT_TOKEN_LIMIT,
  ),
} = {}) {
  const codeRoot = path.resolve(root);
  if (!Number.isInteger(toolOutputTokenLimit)
    || toolOutputTokenLimit < 1
    || toolOutputTokenLimit > MAX_TOOL_OUTPUT_TOKEN_LIMIT) {
    throw new Error(
      `toolOutputTokenLimit must be an integer between 1 and ${MAX_TOOL_OUTPUT_TOKEN_LIMIT}.`,
    );
  }
  const realCodeRootPromise = fs.realpath(codeRoot);

  function resolveLexicalPath(input) {
    const candidate = path.resolve(codeRoot, String(input || "."));
    if (candidate !== codeRoot && !candidate.startsWith(`${codeRoot}${path.sep}`)) {
      throw new Error(`Path is outside CODE_ROOT: ${input}`);
    }
    return candidate;
  }

  function assertInsideRealRoot(candidate, realCodeRoot, input) {
    if (candidate !== realCodeRoot && !candidate.startsWith(`${realCodeRoot}${path.sep}`)) {
      throw new Error(`Path escapes CODE_ROOT through a symbolic link: ${input}`);
    }
    return candidate;
  }

  async function resolveExistingPath(input) {
    const candidate = resolveLexicalPath(input);
    const realCodeRoot = await realCodeRootPromise;
    return assertInsideRealRoot(await fs.realpath(candidate), realCodeRoot, input);
  }

  async function resolveWritablePath(input) {
    const candidate = resolveLexicalPath(input);
    const realCodeRoot = await realCodeRootPromise;
    try {
      return assertInsideRealRoot(await fs.realpath(candidate), realCodeRoot, input);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    let ancestor = path.dirname(candidate);
    let realAncestor;
    while (true) {
      try {
        realAncestor = await fs.realpath(ancestor);
        break;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        const parent = path.dirname(ancestor);
        if (parent === ancestor) throw error;
        ancestor = parent;
      }
    }
    assertInsideRealRoot(realAncestor, realCodeRoot, input);
    const projected = path.resolve(realAncestor, path.relative(ancestor, candidate));
    assertInsideRealRoot(projected, realCodeRoot, input);

    await fs.mkdir(path.dirname(projected), { recursive: true });
    const realParent = assertInsideRealRoot(
      await fs.realpath(path.dirname(projected)),
      realCodeRoot,
      input,
    );
    const writable = path.join(realParent, path.basename(projected));
    try {
      return assertInsideRealRoot(await fs.realpath(writable), realCodeRoot, input);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      return writable;
    }
  }

  const handlers = {
    async list_files({ directory }) {
      const dir = await resolveExistingPath(directory);
      const realCodeRoot = await realCodeRootPromise;
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const lines = entries
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((entry) => `${entry.isDirectory() ? "[dir] " : "      "}${path.relative(realCodeRoot, path.join(dir, entry.name))}`);
      return textResult(lines.join("\n") || "(empty)");
    },

    async read_file({ file_path, max_bytes }) {
      const file = await resolveExistingPath(file_path);
      const data = await fs.readFile(file);
      if (data.byteLength > max_bytes) throw new Error(`File exceeds max_bytes: ${file_path}`);
      return textResult(data.toString("utf8"));
    },

    async write_file({ file_path, content }) {
      const file = await resolveWritablePath(file_path);
      const realCodeRoot = await realCodeRootPromise;
      await fs.writeFile(file, content, "utf8");
      return textResult(`Wrote ${path.relative(realCodeRoot, file)} (${Buffer.byteLength(content)} bytes).`);
    },

    async edit_file({ file_path, old_text, new_text, replace_all }) {
      const file = await resolveExistingPath(file_path);
      const realCodeRoot = await realCodeRootPromise;
      const current = await fs.readFile(file, "utf8");
      const count = current.split(old_text).length - 1;
      if (!count) throw new Error(`old_text was not found in ${file_path}`);
      if (!replace_all && count !== 1) {
        throw new Error(`old_text occurs ${count} times; set replace_all=true or provide a larger fragment`);
      }
      const updated = replace_all
        ? current.split(old_text).join(new_text)
        : current.replace(old_text, new_text);
      await fs.writeFile(file, updated, "utf8");
      return textResult(`Edited ${path.relative(realCodeRoot, file)} (${replace_all ? count : 1} replacement).`);
    },

    async run_shell({ command, cwd, timeout_ms }) {
      const workdir = await resolveExistingPath(cwd);
      try {
        const shell = shellInvocation(command, { platform, configuredShell: env.NOTION_SHELL });
        const { stdout, stderr } = await execFileAsync(shell.executable, shell.args, {
          cwd: workdir,
          timeout: timeout_ms,
          maxBuffer: SHELL_OUTPUT_LIMIT,
          env,
        });
        return textResult(`${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}` || "(command completed with no output)");
      } catch (error) {
        const stdout = error?.stdout || "";
        const stderr = error?.stderr || error?.message || "";
        return textResult(`${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}`, { isError: true });
      }
    },
  };

  const definitions = TOOL_DEFINITIONS.map((definition) => ({ ...definition }));
  const definitionByName = new Map(definitions.map((definition) => [definition.name, definition]));

  async function callTool(name, argumentsValue = {}) {
    const definition = definitionByName.get(String(name));
    const handler = handlers[name];
    if (!definition || !handler) throw new Error(`Unknown runtime tool: ${name}`);
    const parsed = z.object(definition.inputSchema).parse(argumentsValue ?? {});
    return limitToolResult(await handler(parsed), toolOutputTokenLimit);
  }

  return {
    root: codeRoot,
    definitions,
    listTools() {
      return definitions.map(({ name, title, description, inputSchema }) => ({
        name,
        title,
        description,
        inputSchema: z.toJSONSchema(z.object(inputSchema)),
      }));
    },
    callTool,
    async callToolText(name, argumentsValue = {}) {
      return JSON.stringify(await callTool(name, argumentsValue));
    },
  };
}
