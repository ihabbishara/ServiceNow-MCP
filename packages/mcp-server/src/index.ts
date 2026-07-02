#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpRuntime } from "@sre/core";
import { createMcpServer } from "./server.js";

const main = async () => {
  // Create runtime with all services
  const runtime = createMcpRuntime();

  // Create MCP server with tools, resources, and prompts
  const server = createMcpServer(runtime);

  // Connect to stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Dispose the local ONNX embedder on shutdown. If a knowledge tool
  // (search_knowledge/index_url) lazy-loaded onnxruntime-node, its native
  // intra-op thread pool aborts ("mutex lock failed") when torn down by a hard
  // process.exit(); knowledge.close() disposes the embedder + store first.
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await runtime.knowledge.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Log to stderr (stdout is reserved for MCP protocol)
  console.error("[sre-ops-mcp] Server started");
  console.error("[sre-ops-mcp] ServiceNow: enabled");
  console.error(
    `[sre-ops-mcp] Azure DevOps: ${runtime.config.azureDevOps.enabled ? "enabled" : "disabled"}`
  );
};

main().catch((error) => {
  console.error("[sre-ops-mcp] Fatal error:", error);
  process.exit(1);
});
