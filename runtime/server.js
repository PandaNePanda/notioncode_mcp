#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import * as z from "zod/v4";
import { shellInvocation } from "./platform.js";

const execFileAsync = promisify(execFile);
const PORT = Number(process.env.PORT || 8787);
const SECRET = process.env.MCP_PATH_SECRET || "";
const ROOT = path.resolve(process.env.CODE_ROOT || os.homedir());

if (!SECRET || SECRET.length < 24) {
  throw new Error("MCP_PATH_SECRET must be at least 24 characters");
}

function resolvePath(input) {
  const candidate = path.resolve(ROOT, String(input || "."));
  if (candidate !== ROOT && !candidate.startsWith(`${ROOT}${path.sep}`)) {
    throw new Error(`Path is outside CODE_ROOT: ${input}`);
  }
  return candidate;
}

function result(text, extra = {}) {
  return { content: [{ type: "text", text }], ...extra };
}

function server() {
  const mcp = new McpServer({ name: "notion-code-runtime", version: "1.0.0" });

  mcp.registerTool("list_files", {
    title: "List project files",
    description: "List files and directories under CODE_ROOT. Paths are relative to CODE_ROOT.",
    inputSchema: { directory: z.string().optional().default(".") },
  }, async ({ directory }) => {
    const dir = resolvePath(directory);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const lines = entries.sort((a, b) => a.name.localeCompare(b.name)).map((entry) =>
      `${entry.isDirectory() ? "[dir] " : "      "}${path.relative(ROOT, path.join(dir, entry.name))}`,
    );
    return result(lines.join("\n") || "(empty)");
  });

  mcp.registerTool("read_file", {
    title: "Read a file",
    description: "Read a UTF-8 text file under CODE_ROOT.",
    inputSchema: { file_path: z.string(), max_bytes: z.number().int().positive().max(2_000_000).optional().default(500_000) },
  }, async ({ file_path, max_bytes }) => {
    const file = resolvePath(file_path);
    const data = await fs.readFile(file);
    if (data.byteLength > max_bytes) throw new Error(`File exceeds max_bytes: ${file_path}`);
    return result(data.toString("utf8"));
  });

  mcp.registerTool("write_file", {
    title: "Write a file",
    description: "Create or replace a UTF-8 text file under CODE_ROOT. Parent directories are created automatically.",
    inputSchema: { file_path: z.string(), content: z.string() },
  }, async ({ file_path, content }) => {
    const file = resolvePath(file_path);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, "utf8");
    return result(`Wrote ${path.relative(ROOT, file)} (${Buffer.byteLength(content)} bytes).`);
  });

  mcp.registerTool("edit_file", {
    title: "Edit a file",
    description: "Replace an exact text fragment in a UTF-8 file under CODE_ROOT.",
    inputSchema: { file_path: z.string(), old_text: z.string(), new_text: z.string(), replace_all: z.boolean().optional().default(false) },
  }, async ({ file_path, old_text, new_text, replace_all }) => {
    const file = resolvePath(file_path);
    const current = await fs.readFile(file, "utf8");
    const count = current.split(old_text).length - 1;
    if (!count) throw new Error(`old_text was not found in ${file_path}`);
    if (!replace_all && count !== 1) throw new Error(`old_text occurs ${count} times; set replace_all=true or provide a larger fragment`);
    const updated = replace_all ? current.split(old_text).join(new_text) : current.replace(old_text, new_text);
    await fs.writeFile(file, updated, "utf8");
    return result(`Edited ${path.relative(ROOT, file)} (${replace_all ? count : 1} replacement).`);
  });

  mcp.registerTool("run_shell", {
    title: "Run shell command",
    description: "Run a native shell command on the coding machine. Use cwd relative to CODE_ROOT. This can change the machine.",
    inputSchema: { command: z.string(), cwd: z.string().optional().default("."), timeout_ms: z.number().int().positive().max(120_000).optional().default(30_000) },
  }, async ({ command, cwd, timeout_ms }) => {
    const workdir = resolvePath(cwd);
    try {
      const shell = shellInvocation(command);
      const { stdout, stderr } = await execFileAsync(shell.executable, shell.args, {
        cwd: workdir,
        timeout: timeout_ms,
        maxBuffer: 2_000_000,
        env: process.env,
      });
      return result(`${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}` || "(command completed with no output)");
    } catch (error) {
      const stdout = error.stdout || "";
      const stderr = error.stderr || error.message || "";
      return result(`${stdout}${stderr ? `\n[stderr]\n${stderr}` : ""}`, { isError: true });
    }
  });

  return mcp;
}

const app = createMcpExpressApp();
const endpoint = `/mcp/${SECRET}`;

app.use((req, res, next) => {
  if (req.path === endpoint || req.path === `/mcp/${SECRET}/`) return next();
  res.status(404).end();
});

app.post(endpoint, async (req, res) => {
  const mcp = server();
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on("close", () => { transport.close(); mcp.close(); });
  } catch (error) {
    console.error("MCP request error:", error);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
  }
});

app.get(endpoint, (_req, res) => res.status(405).end());
app.delete(endpoint, (_req, res) => res.status(405).end());

app.listen(PORT, "127.0.0.1", () => {
  console.error(`notion-code-mcp listening on 127.0.0.1:${PORT}`);
});
