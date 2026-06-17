import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { McpRuntime } from "@sre/core";

export const registerChangeTools = (server: McpServer, runtime: McpRuntime): void => {
  // search_changes - Search ServiceNow change records
  server.tool(
    "search_changes",
    "Search ServiceNow change records with filters",
    {
      state_not: z.string().optional().describe("Exclude changes with this state. Numeric change_request state code (e.g. '3'=Implement, '4'=Review), not a state name"),
      assignment_group: z.string().optional().describe("Filter by assignment group"),
      configuration_item: z.string().optional().describe("Filter by configuration item"),
      started_after: z.string().optional().describe("Changes started after this date (ISO 8601)"),
      started_before: z.string().optional().describe("Changes started before this date (ISO 8601)"),
      risk: z.enum(["High", "Medium", "Low"]).optional().describe("Filter by risk level"),
      limit: z.number().optional().describe("Maximum results (default: 50)")
    },
    async (args) => {
      try {
        const changes = await runtime.serviceNowClient.listChangesWithFilters({
          stateNot: args.state_not,
          assignmentGroup: args.assignment_group,
          configurationItem: args.configuration_item,
          startedAfter: args.started_after,
          startedBefore: args.started_before,
          limit: args.limit ?? 50
        });

        // Risk is a display value not exposed to the encoded query, so filter it client-side.
        // started_before is now applied server-side (above) so the row limit sees the filtered set.
        let filteredChanges = changes;
        if (args.risk) {
          filteredChanges = changes.filter((c) => c.risk?.toLowerCase() === args.risk?.toLowerCase());
        }

        const result = {
          count: filteredChanges.length,
          changes: filteredChanges.map((c) => ({
            number: c.number,
            state: c.state,
            shortDescription: c.shortDescription,
            risk: c.risk,
            assignmentGroup: c.assignmentGroup,
            plannedStartDate: c.plannedStartDate,
            plannedEndDate: c.plannedEndDate,
            actualStartDate: c.actualStartDate
          }))
        };

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error searching changes: ${error}` }],
          isError: true
        };
      }
    }
  );

  // get_change - Get full details of a specific change
  server.tool(
    "get_change",
    "Get complete details of a specific change record by number (e.g., CHG0005432)",
    {
      number: z.string().describe("Change number (e.g., CHG0005432)")
    },
    async (args) => {
      try {
        const change = await runtime.serviceNowClient.getChangeByNumber(args.number);

        if (!change) {
          return {
            content: [{ type: "text", text: `Change ${args.number} not found` }],
            isError: true
          };
        }

        return {
          content: [{ type: "text", text: JSON.stringify(change, null, 2) }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error fetching change: ${error}` }],
          isError: true
        };
      }
    }
  );

  // correlate_changes - Find changes related to an incident
  server.tool(
    "correlate_changes",
    "Find changes that may be related to an incident by configuration item, business service, assignment group, or time window",
    {
      incident_number: z.string().describe("Incident to find related changes for"),
      window_hours_before: z.number().optional().describe("Hours before incident to search (default: 24)"),
      window_hours_after: z.number().optional().describe("Hours after incident to search (default: 4)")
    },
    async (args) => {
      try {
        // Build a per-call window only if the caller overrode either bound; otherwise
        // pass undefined so the service uses the configured CORRELATION_HOURS_* defaults.
        const defaults = runtime.config.thresholds.relatedChangeWindow;
        const window =
          args.window_hours_before !== undefined || args.window_hours_after !== undefined
            ? {
                beforeHours: args.window_hours_before ?? defaults.beforeHours,
                afterHours: args.window_hours_after ?? defaults.afterHours
              }
            : undefined;
        const relatedChanges = await runtime.incidentService.findRelatedChanges(args.incident_number, window);

        const result = {
          incidentNumber: args.incident_number,
          count: relatedChanges.length,
          changes: relatedChanges.map((c) => ({
            changeNumber: c.changeNumber,
            shortDescription: c.shortDescription,
            state: c.state,
            risk: c.risk,
            plannedStart: c.plannedStart,
            actualStart: c.actualStart,
            correlationReason: c.correlationReason,
            confidenceScore: c.confidenceScore
          }))
        };

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error correlating changes: ${error}` }],
          isError: true
        };
      }
    }
  );
};
