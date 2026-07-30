#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import {
  discoverExternalModels,
  externalProviderStatus,
  generateExternal,
} from "./external-inference-client.js";

function textResult(data) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

function toolError(error) {
  return {
    content: [{
      type: "text",
      text: error instanceof Error ? error.message : String(error),
    }],
    isError: true,
  };
}

async function runTool(handler) {
  try {
    return await handler();
  } catch (error) {
    return toolError(error);
  }
}

export function buildExternalInferenceServer() {
  const server = new McpServer({
    name: "external-inference-mcp",
    version: "0.1.0",
  });

  server.registerTool("external_provider_status", {
    title: "External Provider Status",
    description:
      "Show which optional external inference providers have a locally configured API key. Never returns key values and does not contact providers.",
    inputSchema: {},
  }, async () => textResult({ providers: externalProviderStatus() }));

  server.registerTool("external_models", {
    title: "External Provider Models",
    description:
      "Read a provider's live model catalog using its locally configured API key. Key values are never returned. Use this to detect newly released models without inventing aliases.",
    inputSchema: {
      provider: z.enum(["openrouter", "vivgrid", "cerebras"])
        .describe("External provider whose live model catalog should be read."),
    },
  }, async (args) => runTool(async () => textResult(await discoverExternalModels(args.provider))));

  server.registerTool("external_generate", {
    title: "External Model Generate",
    description:
      "Send one text-generation request to a separately billed external provider and report elapsed time. This does not accelerate Notion AI or reuse Notion usage. Use only when the user explicitly wants an external high-speed model.",
    inputSchema: {
      provider: z.enum(["openrouter", "vivgrid", "cerebras"])
        .describe("External provider to call."),
      user_authorized_external_billing: z.literal(true)
        .describe("Must be true only after the user explicitly requested this separately billed external request."),
      model: z.string().optional()
        .describe("Provider model ID. Static models are accepted locally; new IDs are accepted only after exact verification against the provider's live model catalog."),
      prompt: z.string().min(1).max(200000)
        .describe("User prompt sent to the external provider."),
      system: z.string().max(50000).optional()
        .describe("Optional system instruction sent to the external provider."),
      reasoning_effort: z.enum(["none", "low", "medium", "high", "xhigh", "max"])
        .optional()
        .describe("Optional provider reasoning effort. Ultra is intentionally excluded because these APIs do not expose a verified Ultra wire value."),
      max_output_tokens: z.number().int().min(1).max(32768).default(4096)
        .describe("Maximum requested output tokens."),
    },
  }, async (args) => runTool(async () => textResult(await generateExternal({
    provider: args.provider,
    model: args.model,
    prompt: args.prompt,
    system: args.system,
    reasoningEffort: args.reasoning_effort,
    maxOutputTokens: args.max_output_tokens,
  }))));

  return server;
}

export async function main() {
  const server = buildExternalInferenceServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
