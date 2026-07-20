// bridge/server.js — Node.js entry point for the Notion bridge server (ESM)
import path from "node:path";
import process from "node:process";

import { AccountPool } from "./src/account-pool.js";
import { TurnAffinityStore } from "./src/turn-affinity.js";
import { ConversationSegmentStore } from "./src/conversation-segments.js";
import { safeErrorMetadata, writeDiagnostic } from "./src/diagnostics.js";
import {
  BRIDGE_PORT,
  closeBridgeServer,
  createBridgeServer,
  listenBridgeServer,
} from "./src/http-server.js";
import { closeMcpServer, createMcpApp, listenMcpServer } from "./src/mcp-server.js";
import { createRuntimeToolService, loadRuntimeConfig } from "./src/runtime-tools.js";

const ACCOUNT_HOME =
  process.env.NOTION_AGENT_HOME ??
  path.join(process.env.HOME ?? "~", ".notionagents");

const WORKFLOW_ID = process.env.NOTION_WORKFLOW_ID ?? "";
const PORT = Number(process.env.NOTION_FABLE_PORT ?? BRIDGE_PORT);

const stateDir = path.join(ACCOUNT_HOME, "state");

const turnAffinities = new TurnAffinityStore(
  path.join(stateDir, "turn-affinity.json"),
);
const conversationSegments = new ConversationSegmentStore(
  path.join(stateDir, "conversation-segments.json"),
);

await turnAffinities.load();
await conversationSegments.load();

const accountPool = await AccountPool.create({ home: ACCOUNT_HOME });
const runtimeConfig = await loadRuntimeConfig();
const runtimeTools = createRuntimeToolService({
  root: runtimeConfig.codeRoot,
  toolOutputTokenLimit: runtimeConfig.toolOutputTokenLimit,
});

const bridgeServer = createBridgeServer({
  accountPool,
  turnAffinities,
  conversationSegments,
  workflowId: WORKFLOW_ID,
  runtimeTools,
});
const mcpApp = createMcpApp({
  secret: runtimeConfig.secret,
  toolService: runtimeTools,
});

let mcpServer;
let bridgeAddress;
try {
  mcpServer = await listenMcpServer(mcpApp, { port: runtimeConfig.port });
  bridgeAddress = await listenBridgeServer(bridgeServer, { port: PORT });
} catch (error) {
  await closeMcpServer(mcpServer).catch(() => {});
  await closeBridgeServer(bridgeServer).catch(() => {});
  await accountPool.close().catch(() => {});
  throw error;
}

writeDiagnostic("server_started", {
  service: "bridge",
  host: "127.0.0.1",
  port: bridgeAddress.port,
  accounts: accountPool.status().configured,
});
writeDiagnostic("server_started", {
  service: "runtime",
  host: "127.0.0.1",
  port: runtimeConfig.port,
});

let shuttingDown = false;
async function shutdown(reason, error = null) {
  if (shuttingDown) return;
  shuttingDown = true;
  writeDiagnostic(error ? "server_failed" : "server_stopping", {
    reason,
    ...(error ? safeErrorMetadata(error) : {}),
  });
  const results = await Promise.allSettled([
    closeBridgeServer(bridgeServer),
    closeMcpServer(mcpServer),
    accountPool.close(),
  ]);
  for (const result of results) {
    if (result.status === "rejected") {
      writeDiagnostic("server_shutdown_failed", safeErrorMetadata(result.reason));
    }
  }
  writeDiagnostic("server_stopped", { reason });
  if (error) process.exitCode = 1;
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("uncaughtException", (error) => void shutdown("uncaught exception", error));
process.once("unhandledRejection", (error) => void shutdown("unhandled rejection", error));
