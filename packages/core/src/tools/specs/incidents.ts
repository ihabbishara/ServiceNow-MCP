import { z } from "zod";
import { ToolError, defineSpec } from "../spec.js";

export const incidentSpecs = [
  defineSpec({
    name: "search_incidents",
    description:
      "Search ServiceNow incidents with filters. Use to find incidents by state, priority, assignment group, or description.",
    schema: {
      state_not: z
        .string()
        .optional()
        .describe(
          "Exclude incidents with this single state name (e.g., 'Resolved' excludes only Resolved, not Closed or Canceled)"
        ),
      priority: z
        .enum(["1", "2", "3", "4"])
        .optional()
        .describe("Filter by priority: 1=Critical, 2=High, 3=Medium, 4=Low"),
      assignment_group: z.string().optional().describe("Filter by assignment group name"),
      assigned_to: z
        .string()
        .optional()
        .describe("Filter by assigned user name (mutually exclusive with unassigned_only)"),
      short_description_contains: z
        .string()
        .optional()
        .describe("Search text in short description"),
      unassigned_only: z
        .boolean()
        .optional()
        .describe("Only show incidents with no assignee (mutually exclusive with assigned_to)"),
      limit: z.number().optional().describe("Maximum results (default: 50, max: 200)")
    },
    run: async (rt, a) => {
      if (a.unassigned_only && a.assigned_to) {
        throw new ToolError(
          "unassigned_only and assigned_to are mutually exclusive — pass only one."
        );
      }
      const incidents = await rt.serviceNowClient.listIncidentsWithFilters({
        stateNot: a.state_not,
        priority: a.priority,
        assignmentGroup: a.assignment_group,
        assignedTo: a.unassigned_only ? "" : a.assigned_to,
        shortDescriptionContains: a.short_description_contains,
        limit: Math.min(a.limit ?? 50, 200)
      });
      return {
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
    }
  }),

  defineSpec({
    name: "get_incident",
    description: "Get complete details of a specific incident by number (e.g., INC0012345)",
    schema: {
      number: z.string().describe("Incident number (e.g., INC0012345)")
    },
    run: async (rt, a) => {
      const incident = await rt.serviceNowClient.getIncidentByNumber(a.number);
      if (!incident) throw new ToolError(`Incident ${a.number} not found`);
      return incident;
    }
  }),

  defineSpec({
    name: "summarize_incident",
    description:
      "Get incident details enriched with related changes and linked Azure DevOps work items. Use for incident analysis, triage, or handover.",
    schema: {
      number: z.string().describe("Incident number (e.g., INC0012345)")
    },
    run: async (rt, a) => {
      const result = await rt.incidentService.summarizeIncident(a.number);
      return {
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
    }
  })
];
