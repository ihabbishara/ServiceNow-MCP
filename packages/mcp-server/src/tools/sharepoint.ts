import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { McpRuntime } from "@sre/core";

const asText = (obj: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }]
});
const asError = (err: unknown) => ({
  content: [{ type: "text" as const, text: `Error: ${String(err)}` }],
  isError: true
});

export const registerSharePointTools = (server: McpServer, runtime: McpRuntime): void => {
  server.tool(
    "get_incident_documents",
    "Fetch an incident's SharePoint documents by number (docx/xlsx/pptx/pdf from the Docs subtree); returns extracted text to cite.",
    { incident: z.string().describe("Incident number, e.g. INC123456") },
    async (args) => {
      try {
        if (!runtime.sharePoint) {
          return asError("SharePoint integration is disabled (set SHAREPOINT_ENABLED=true).");
        }
        return asText(await runtime.sharePoint.getIncidentDocuments(args.incident));
      } catch (error) {
        return asError(error);
      }
    }
  );
};
