#!/usr/bin/env node

import { main } from "./src/external-inference-server.js";

main().catch((error) => {
  console.error("External inference MCP startup failed:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
