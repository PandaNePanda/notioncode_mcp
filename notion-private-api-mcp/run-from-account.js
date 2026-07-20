#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const accountHome = process.env.NOTION_AGENT_HOME || path.join(os.homedir(), ".notionagents");
const accountPath = path.join(accountHome, "notion_account.json");

if (!fs.existsSync(accountPath)) {
  throw new Error(`Notion account file is missing: ${accountPath}`);
}

const account = JSON.parse(fs.readFileSync(accountPath, "utf8"));
if (typeof account.token_v2 !== "string" || !account.token_v2) {
  throw new Error(`token_v2 is missing from ${accountPath}`);
}

process.env.NOTION_TOKEN_V2 = account.token_v2;
const serverPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "src", "server.js");
await import(pathToFileURL(serverPath).href);
