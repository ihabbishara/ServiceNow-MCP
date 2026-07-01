import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { McpRuntime, listCsvFiles, readCsvFile } from "@sre/core";

export const registerWorkItemCsvTools = (server: McpServer, runtime: McpRuntime): void => {
  const csvDir = () => runtime.config.azureDevOps.csvDir;

  const guard = (): { type: "text"; text: string } | null => {
    if (!runtime.config.azureDevOps.enabled) return { type: "text", text: "Azure DevOps integration is disabled. Set ADO_ENABLED=true." };
    if (!csvDir()) return { type: "text", text: "CSV folder not configured. Set ADO_CSV_DIR to a folder of .csv files." };
    return null;
  };

  server.tool(
    "list_work_item_csvs",
    "List CSV files available in the configured work-item CSV folder (ADO_CSV_DIR). Use read_work_item_csv to load one, then create_work_item / clone_work_item per row.",
    {},
    async () => {
      const g = guard();
      if (g) return { content: [g], isError: true };
      try {
        const files = await listCsvFiles(csvDir() as string);
        return { content: [{ type: "text", text: JSON.stringify({ files }, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error listing CSV files: ${error}` }], isError: true };
      }
    }
  );

  server.tool(
    "read_work_item_csv",
    "Read a CSV file from the configured folder (ADO_CSV_DIR) and return its headers and rows as structured JSON. Then detect which rows are stories/tasks and call create_work_item / clone_work_item per row.",
    { filename: z.string().describe("CSV filename within ADO_CSV_DIR (no path separators)") },
    async (args) => {
      const g = guard();
      if (g) return { content: [g], isError: true };
      try {
        const table = await readCsvFile(csvDir() as string, args.filename, runtime.config.azureDevOps.csvMaxBytes);
        return { content: [{ type: "text", text: JSON.stringify(table, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error reading CSV: ${error}` }], isError: true };
      }
    }
  );
};
