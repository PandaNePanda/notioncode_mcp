import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { DEFAULT_MCP_PORT } from "./runtime-tools.js";

export const MCP_HOST = "127.0.0.1";

function createSessionServer(toolService) {
  const mcp = new McpServer({ name: "notion-code-runtime", version: "1.0.0" });
  for (const definition of toolService.definitions) {
    mcp.registerTool(definition.name, {
      title: definition.title,
      description: definition.description,
      inputSchema: definition.inputSchema,
    }, (argumentsValue) => toolService.callTool(definition.name, argumentsValue));
  }
  return mcp;
}

export function createMcpApp({ secret, toolService }) {
  if (!secret || secret.length < 24) {
    throw new Error("MCP_PATH_SECRET must be at least 24 characters.");
  }
  if (!toolService) throw new TypeError("A runtime tool service is required.");

  const app = createMcpExpressApp();
  const endpoint = `/mcp/${secret}`;

  app.use((request, response, next) => {
    if (request.path === endpoint || request.path === `${endpoint}/`) return next();
    response.status(404).end();
  });

  app.post(endpoint, async (request, response) => {
    const mcp = createSessionServer(toolService);
    let transport;
    try {
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await mcp.connect(transport);
      await transport.handleRequest(request, response, request.body);
      response.on("close", () => {
        void transport.close();
        void mcp.close();
      });
    } catch (error) {
      console.error("MCP request error:", error);
      void transport?.close();
      void mcp.close();
      if (!response.headersSent) {
        response.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  app.get(endpoint, (_request, response) => response.status(405).end());
  app.delete(endpoint, (_request, response) => response.status(405).end());
  return app;
}

export async function listenMcpServer(app, { port = DEFAULT_MCP_PORT } = {}) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, MCP_HOST);
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(server);
    };
    server.once("error", onError);
    server.once("listening", onListening);
  });
}

export async function closeMcpServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
