// bridge/server.js — Node.js entry point for the Notion bridge server (ESM)
import path from "node:path";
import process from "node:process";

import { AccountPool } from "./src/account-pool.js";
import { TurnAffinityStore } from "./src/turn-affinity.js";
import { ConversationSegmentStore } from "./src/conversation-segments.js";
import { createBridgeServer, listenBridgeServer, BRIDGE_PORT } from "./src/http-server.js";

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

const server = createBridgeServer({
  accountPool,
  turnAffinities,
  conversationSegments,
  workflowId: WORKFLOW_ID,
});

const address = await listenBridgeServer(server, { port: PORT });
console.log(`[bridge] listening on http://127.0.0.1:${address.port}`);
