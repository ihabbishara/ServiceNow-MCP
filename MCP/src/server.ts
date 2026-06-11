import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpRuntime } from "./runtime.js";
import { registerIncidentTools } from "./tools/incidents.js";
import { registerChangeTools } from "./tools/changes.js";
import { registerAnalysisTools } from "./tools/analysis.js";
import { registerAdoTools } from "./tools/ado.js";
import { registerIncidentResources, registerTeamResources } from "./resources/incidents.js";
import { registerChangeResources } from "./resources/changes.js";
import { registerDashboardResources } from "./resources/dashboards.js";
import { registerPrompts } from "./prompts/index.js";

export const createMcpServer = (runtime: McpRuntime): McpServer => {
  const server = new McpServer({
    name: "sre-ops",
    version: "1.0.0"
  });

  // Register all tools
  registerIncidentTools(server, runtime);
  registerChangeTools(server, runtime);
  registerAnalysisTools(server, runtime);
  registerAdoTools(server, runtime);

  // Register all resources
  registerIncidentResources(server, runtime);
  registerTeamResources(server, runtime);
  registerChangeResources(server, runtime);
  registerDashboardResources(server, runtime);

  // Register all prompts
  registerPrompts(server, runtime);

  return server;
};
