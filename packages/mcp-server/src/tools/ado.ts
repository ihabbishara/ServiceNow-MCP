import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { McpRuntime } from "@sre/core";

export const registerAdoTools = (server: McpServer, runtime: McpRuntime): void => {
  // search_work_items - Search Azure DevOps work items
  server.tool(
    "search_work_items",
    "Search Azure DevOps work items by text, type, or state",
    {
      query_text: z.string().describe("Text to search for (e.g., incident number)"),
      work_item_type: z.enum(["Bug", "Task", "User Story", "Issue"]).optional().describe("Filter by work item type"),
      state: z.string().optional().describe("Filter by state (e.g., 'Active', 'Closed')")
    },
    async (args) => {
      try {
        if (!runtime.config.azureDevOps.enabled) {
          return {
            content: [{ type: "text", text: "Azure DevOps integration is disabled. Set ADO_ENABLED=true to search work items." }],
            isError: true
          };
        }

        const workItems = await runtime.azureDevOpsClient.searchWorkItems({
          text: args.query_text,
          workItemType: args.work_item_type,
          state: args.state
        });

        const result = {
          count: workItems.length,
          workItems: workItems.map((w) => ({
            id: w.id,
            title: w.title,
            state: w.state,
            assignedTo: w.assignedTo,
            areaPath: w.areaPath,
            tags: w.tags
          }))
        };

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error searching work items: ${error}` }],
          isError: true
        };
      }
    }
  );

  // create_bug_from_incident - Create ADO bug from ServiceNow incident
  server.tool(
    "create_bug_from_incident",
    "Create an Azure DevOps bug linked to a ServiceNow incident. Includes incident details, priority mapping, and standard acceptance criteria.",
    {
      incident_number: z.string().describe("Incident to create bug from"),
      title_override: z.string().optional().describe("Custom title (default: uses incident short description)"),
      additional_tags: z.array(z.string()).optional().describe("Extra tags to add"),
      area_path: z.string().optional().describe("ADO area path (default: from config)"),
      iteration_path: z.string().optional().describe("ADO iteration path (default: from config)")
    },
    async (args) => {
      try {
        // Check if ADO integration is enabled
        if (!runtime.config.azureDevOps.enabled) {
          return {
            content: [{ type: "text", text: "ADO integration is disabled. Enable it to create bugs." }],
            isError: true
          };
        }

        // Check feature flag
        if (!runtime.config.features.createAdoBug) {
          return {
            content: [{ type: "text", text: "ADO bug creation is disabled by feature flag." }],
            isError: true
          };
        }

        // Get incident details
        const summary = await runtime.incidentService.summarizeIncident(args.incident_number);

        // Build bug payload
        const title = args.title_override ?? `[${summary.incident.number}] ${summary.incident.shortDescription}`;
        const description = [
          `ServiceNow Incident: ${summary.incident.number}`,
          `Priority: ${summary.incident.priority}`,
          `Business Service: ${summary.incident.businessService ?? "N/A"}`,
          `Configuration Item: ${summary.incident.cmdbCi ?? "N/A"}`,
          "",
          "## Description",
          summary.incident.description ?? summary.incident.shortDescription,
          "",
          "## Acceptance Criteria",
          "- Root cause is identified and documented",
          "- Mitigation and permanent fix tasks are tracked",
          "- Runbook and monitoring updates are completed"
        ].join("\n");

        const tags = ["ServiceNow", "Incident", "SRE", ...(args.additional_tags ?? [])];

        const created = await runtime.azureDevOpsClient.createBug({
          title,
          description,
          areaPath: args.area_path ?? runtime.config.azureDevOps.defaultAreaPath,
          iterationPath: args.iteration_path ?? runtime.config.azureDevOps.defaultIterationPath,
          tags,
          assignedTeam: runtime.config.azureDevOps.defaultAssignedTeam,
          priority: summary.incident.priority,
          incidentNumber: args.incident_number
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  success: true,
                  bugId: created.id,
                  title: created.title,
                  linkedIncident: args.incident_number,
                  message: `Bug ${created.id} created successfully`
                },
                null,
                2
              )
            }
          ]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error creating bug: ${error}` }],
          isError: true
        };
      }
    }
  );
};
