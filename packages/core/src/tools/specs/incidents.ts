import { z } from "zod";
import { ToolError, defineSpec } from "../spec.js";
import { detectCodeSignals } from "../../services/codeSignals.js";
import type { McpRuntime } from "../../runtime.js";

// Surface-neutral: sre-agent has analyze_code; MCP hosts fall back to the raw repo tools.
const CODE_ANALYSIS_NEXT_STEP =
  "Code-referencing errors detected in this incident. Proactively ask the user whether they want a " +
  "codebase root-cause analysis. If they accept, ask for the Azure DevOps repo clone URL " +
  "(https://dev.azure.com/<org>/<project>/_git/<repo>) and optionally the deployed branch/tag, then " +
  "run analyze_code with the incident's error text — or use checkout_repo/search_repo/read_repo_file " +
  "directly if analyze_code is not available on this surface.";

interface IncidentTexts {
  shortDescription?: string;
  description?: string;
  workNotes?: string[];
  comments?: string[];
}

/** Structural engagement hint: {} unless ADO is configured AND the incident text carries code signals. */
const codeAnalysisHint = (
  rt: McpRuntime,
  inc: IncidentTexts
): { codeAnalysis?: { signalsDetected: true; signals: string[]; nextStep: string } } => {
  if (!rt.config.azureDevOps.orgUrl) return {};
  const { detected, signals } = detectCodeSignals([
    inc.shortDescription,
    inc.description,
    ...(inc.workNotes ?? []),
    ...(inc.comments ?? [])
  ]);
  if (!detected) return {};
  return { codeAnalysis: { signalsDetected: true, signals, nextStep: CODE_ANALYSIS_NEXT_STEP } };
};

export const incidentSpecs = [
  defineSpec({
    name: "search_incidents",
    description:
      "Search ServiceNow incidents with filters. Name filters (assignment_group, assigned_to) are " +
      "case-insensitive contains-matches like the ServiceNow UI, so partial names such as 'GIOM' work. " +
      "Returns all states unless only_open is set.",
    schema: {
      state_not: z
        .string()
        .optional()
        .describe(
          "Exclude incidents with this single state name (e.g., 'Resolved' excludes only Resolved, not Closed or Canceled)"
        ),
      only_open: z
        .boolean()
        .optional()
        .describe(
          "Exclude Resolved/Closed/Canceled incidents. Set only when the user explicitly asks for open/active/unresolved incidents; omit to search all states"
        ),
      priority: z
        .enum(["1", "2", "3", "4"])
        .optional()
        .describe("Filter by priority: 1=Critical (P1), 2=High (P2), 3=Medium (P3), 4=Low (P4)"),
      assignment_group: z
        .string()
        .optional()
        .describe(
          "Filter by assignment group — partial name OK, contains-match (e.g. 'GIOM' matches 'T01234-Avengers-GIOM')"
        ),
      assigned_to: z
        .string()
        .optional()
        .describe(
          "Filter by assigned user — partial name OK, contains-match (mutually exclusive with unassigned_only)"
        ),
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
        onlyOpen: a.only_open,
        stateNot: a.state_not,
        priority: a.priority,
        assignmentGroup: a.assignment_group,
        assignedTo: a.unassigned_only ? "" : a.assigned_to,
        shortDescriptionContains: a.short_description_contains,
        limit: Math.min(a.limit ?? 50, 200)
      });

      const stateBreakdown: Record<string, number> = {};
      for (const inc of incidents) stateBreakdown[inc.state] = (stateBreakdown[inc.state] ?? 0) + 1;

      // Group filter transparency: show which full group names the contains-match hit,
      // and on zero hits distinguish "no such group" from "group exists, other filters exclude all".
      let matchedAssignmentGroups: string[] | undefined;
      let hint: string | undefined;
      if (a.assignment_group) {
        matchedAssignmentGroups = [
          ...new Set(incidents.map((i) => i.assignmentGroup).filter((g): g is string => !!g))
        ];
        if (incidents.length === 0) {
          try {
            const groups = await rt.serviceNowClient.lookupGroups(a.assignment_group);
            hint = groups.length
              ? `No incidents matched, but these assignment groups contain '${a.assignment_group}': ` +
                `${groups.map((g) => g.name).join(", ")}. The group filter is fine — relax the other filters (state, priority, text) or confirm intent with the user.`
              : `No assignment group name contains '${a.assignment_group}'. Verify the group name with the user or explore with lookup_assignment_groups.`;
          } catch {
            // lookup is best-effort; the empty result stands on its own
          }
        }
      }

      return {
        count: incidents.length,
        ...(matchedAssignmentGroups ? { matchedAssignmentGroups } : {}),
        ...(incidents.length ? { stateBreakdown } : {}),
        ...(hint ? { hint } : {}),
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
    name: "lookup_assignment_groups",
    description:
      "Find ServiceNow assignment groups by partial name (case-insensitive contains-match). Use to " +
      "resolve short names like 'GIOM' to full group names such as 'T01234-Avengers-GIOM', or when a " +
      "group-filtered search returns nothing.",
    schema: {
      name_contains: z.string().describe("Partial group name to match (e.g. 'GIOM')"),
      limit: z.number().optional().describe("Maximum results (default: 20, max: 50)")
    },
    run: async (rt, a) => {
      const groups = await rt.serviceNowClient.lookupGroups(a.name_contains, a.limit ?? 20);
      return {
        count: groups.length,
        groups: groups.map((g) => ({
          name: g.name,
          description: g.description ?? null,
          active: g.active
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
      return { ...incident, ...codeAnalysisHint(rt, incident) };
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
        })),
        ...codeAnalysisHint(rt, result.incident)
      };
    }
  })
];
