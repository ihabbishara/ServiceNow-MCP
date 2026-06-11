import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { McpRuntime } from "../runtime.js";

export const registerIncidentTools = (server: McpServer, runtime: McpRuntime): void => {
  // search_incidents - Search ServiceNow incidents with filters
  server.tool(
    "search_incidents",
    "Search ServiceNow incidents with filters. Use to find incidents by state, priority, assignment group, or description.",
    {
      state_not: z.string().optional().describe("Exclude incidents with this state (e.g., 'Closed', 'Resolved')"),
      priority: z.enum(["1", "2", "3", "4"]).optional().describe("Filter by priority: 1=Critical, 2=High, 3=Medium, 4=Low"),
      assignment_group: z.string().optional().describe("Filter by assignment group name"),
      assigned_to: z.string().optional().describe("Filter by assigned user name"),
      short_description_contains: z.string().optional().describe("Search text in short description"),
      unassigned_only: z.boolean().optional().describe("Only show incidents with no assignee"),
      limit: z.number().optional().describe("Maximum results (default: 50, max: 200)")
    },
    async (args) => {
      try {
        const incidents = await runtime.serviceNowClient.listIncidentsWithFilters({
          stateNot: args.state_not,
          priority: args.priority,
          assignmentGroup: args.assignment_group,
          assignedTo: args.unassigned_only ? "" : args.assigned_to,
          shortDescriptionContains: args.short_description_contains,
          limit: Math.min(args.limit ?? 50, 200)
        });

        const result = {
          count: incidents.length,
          incidents: incidents.map((inc) => ({
            number: inc.number,
            priority: inc.priority,
            state: inc.state,
            shortDescription: inc.shortDescription,
            assignedTo: inc.assignedTo ?? null,
            assignmentGroup: inc.assignmentGroup ?? null,
            openedAt: inc.openedAt,
            updatedAt: inc.updatedAt
          }))
        };

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error searching incidents: ${error}` }],
          isError: true
        };
      }
    }
  );

  // get_incident - Get full details of a specific incident
  server.tool(
    "get_incident",
    "Get complete details of a specific incident by number (e.g., INC0012345)",
    {
      number: z.string().describe("Incident number (e.g., INC0012345)")
    },
    async (args) => {
      try {
        const incident = await runtime.serviceNowClient.getIncidentByNumber(args.number);

        if (!incident) {
          return {
            content: [{ type: "text", text: `Incident ${args.number} not found` }],
            isError: true
          };
        }

        return {
          content: [{ type: "text", text: JSON.stringify(incident, null, 2) }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error fetching incident: ${error}` }],
          isError: true
        };
      }
    }
  );

  // summarize_incident - Get incident with related changes and ADO items
  server.tool(
    "summarize_incident",
    "Get incident details enriched with related changes and linked Azure DevOps work items. Use for incident analysis, triage, or handover.",
    {
      number: z.string().describe("Incident number (e.g., INC0012345)")
    },
    async (args) => {
      try {
        const result = await runtime.incidentService.summarizeIncident(args.number);

        const summary = {
          incident: {
            number: result.incident.number,
            priority: result.incident.priority,
            state: result.incident.state,
            shortDescription: result.incident.shortDescription,
            description: result.incident.description,
            assignedTo: result.incident.assignedTo,
            assignmentGroup: result.incident.assignmentGroup,
            businessService: result.incident.businessService,
            cmdbCi: result.incident.cmdbCi,
            openedAt: result.incident.openedAt,
            updatedAt: result.incident.updatedAt,
            slaDue: result.incident.slaDue,
            workNotes: result.incident.workNotes,
            comments: result.incident.comments
          },
          relatedChanges: result.relatedChanges.map((c) => ({
            changeNumber: c.changeNumber,
            shortDescription: c.shortDescription,
            state: c.state,
            risk: c.risk,
            correlationReason: c.correlationReason,
            confidenceScore: c.confidenceScore
          })),
          relatedWorkItems: result.relatedWorkItems.map((w) => ({
            id: w.id,
            title: w.title,
            state: w.state
          }))
        };

        return {
          content: [{ type: "text", text: JSON.stringify(summary, null, 2) }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error summarizing incident: ${error}` }],
          isError: true
        };
      }
    }
  );
};
