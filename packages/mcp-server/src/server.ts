import { createRequire } from "module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpRuntime } from "@sre/core";
import { registerIncidentTools } from "./tools/incidents.js";
import { registerChangeTools } from "./tools/changes.js";
import { registerAnalysisTools } from "./tools/analysis.js";
import { registerAdoTools } from "./tools/ado.js";
import { registerKnowledgeTools } from "./tools/knowledge.js";
import { registerSharePointTools } from "./tools/sharepoint.js";
import { registerIncidentResources, registerTeamResources } from "./resources/incidents.js";
import { registerChangeResources } from "./resources/changes.js";
import { registerDashboardResources } from "./resources/dashboards.js";
import { registerPrompts } from "./prompts/index.js";

// Read the package version at runtime so server metadata can't drift from package.json.
const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

export const createMcpServer = (runtime: McpRuntime): McpServer => {
  const server = new McpServer({
    name: "sre-ops",
    version
  });

  // Register all tools
  registerIncidentTools(server, runtime);
  registerChangeTools(server, runtime);
  registerAnalysisTools(server, runtime);
  registerAdoTools(server, runtime);
  registerKnowledgeTools(server, runtime);
  registerSharePointTools(server, runtime);

  // Register all resources
  registerIncidentResources(server, runtime);
  registerTeamResources(server, runtime);
  registerChangeResources(server, runtime);
  registerDashboardResources(server, runtime);

  // Register all prompts
  registerPrompts(server, runtime);

  return server;
};
