#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpRuntime } from "./runtime.js";
import { createMcpServer } from "./server.js";

const main = async () => {
  // Create runtime with all services
  const runtime = createMcpRuntime();

  // Create MCP server with tools, resources, and prompts
  const server = createMcpServer(runtime);

  // Connect to stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log to stderr (stdout is reserved for MCP protocol)
  console.error("[sre-ops-mcp] Server started");
  console.error("[sre-ops-mcp] ServiceNow: enabled");
  console.error(`[sre-ops-mcp] Azure DevOps: ${runtime.config.azureDevOps.enabled ? "enabled" : "disabled"}`);
};

main().catch((error) => {
  console.error("[sre-ops-mcp] Fatal error:", error);
  process.exit(1);
});
