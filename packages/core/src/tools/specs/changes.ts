import { z } from "zod";
import { ToolError, defineSpec } from "../spec.js";

export const changeSpecs = [
  defineSpec({
    name: "search_changes",
    description:
      "Search ServiceNow change records with filters. Name filters (assignment_group, configuration_item) are case-insensitive contains-matches, so partial names work.",
    schema: {
      state_not: z
        .string()
        .optional()
        .describe(
          "Exclude changes with this state. Numeric change_request state code (e.g. '3'=Implement, '4'=Review), not a state name"
        ),
      assignment_group: z
        .string()
        .optional()
        .describe(
          "Filter by assignment group — partial name OK, case-insensitive contains-match (e.g. 'GIOM' matches 'T01234-Avengers-GIOM')"
        ),
      configuration_item: z
        .string()
        .optional()
        .describe("Filter by configuration item — partial name OK, contains-match"),
      started_after: z.string().optional().describe("Changes started after this date (ISO 8601)"),
      started_before: z.string().optional().describe("Changes started before this date (ISO 8601)"),
      risk: z.enum(["High", "Medium", "Low"]).optional().describe("Filter by risk level"),
      limit: z.number().optional().describe("Maximum results (default: 50)")
    },
    run: async (rt, a) => {
      const changes = await rt.serviceNowClient.listChangesWithFilters({
        stateNot: a.state_not,
        assignmentGroup: a.assignment_group,
        configurationItem: a.configuration_item,
        startedAfter: a.started_after,
        startedBefore: a.started_before,
        limit: a.limit ?? 50
      });

      // Risk is a display value not exposed to the encoded query, so filter it client-side.
      let filteredChanges = changes;
      if (a.risk) {
        filteredChanges = changes.filter((c) => c.risk?.toLowerCase() === a.risk?.toLowerCase());
      }

      return {
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
    }
  }),

  defineSpec({
    name: "get_change",
    description: "Get complete details of a specific change record by number (e.g., CHG0005432)",
    schema: {
      number: z.string().describe("Change number (e.g., CHG0005432)")
    },
    run: async (rt, a) => {
      const change = await rt.serviceNowClient.getChangeByNumber(a.number);
      if (!change) throw new ToolError(`Change ${a.number} not found`);
      return change;
    }
  }),

  defineSpec({
    name: "correlate_changes",
    description:
      "Find changes that may be related to an incident by configuration item, business service, assignment group, or time window",
    schema: {
      incident_number: z.string().describe("Incident to find related changes for"),
      window_hours_before: z
        .number()
        .optional()
        .describe("Hours before incident to search (default: 24)"),
      window_hours_after: z
        .number()
        .optional()
        .describe("Hours after incident to search (default: 4)")
    },
    run: async (rt, a) => {
      // Build a per-call window only if the caller overrode either bound; otherwise
      // pass undefined so the service uses the configured CORRELATION_HOURS_* defaults.
      const defaults = rt.config.thresholds.relatedChangeWindow;
      const window =
        a.window_hours_before !== undefined || a.window_hours_after !== undefined
          ? {
              beforeHours: a.window_hours_before ?? defaults.beforeHours,
              afterHours: a.window_hours_after ?? defaults.afterHours
            }
          : undefined;
      const relatedChanges = await rt.incidentService.findRelatedChanges(a.incident_number, window);

      return {
        incidentNumber: a.incident_number,
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
    }
  })
];
