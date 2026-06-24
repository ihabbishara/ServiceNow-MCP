import { defineTool } from "@github/copilot-sdk";
import { z } from "zod";
import type { McpRuntime } from "@sre/core";

/**
 * All 12 custom tools projected from `@sre/core` for the Copilot SDK.
 *
 * Each handler calls the matching `runtime.<service>` method and returns the
 * SAME projected JSON the mcp-server tools return (the projections are copied
 * verbatim from `packages/mcp-server/src/tools/*.ts`). The 11 read tools set
 * `skipPermission: true`; only `create_bug_from_incident` is gated.
 *
 * On any error a handler returns `{ error: String(err) }` — it never throws, so
 * the model sees a structured error instead of the turn failing.
 */
export const buildTools = (runtime: McpRuntime) => [
  defineTool("search_incidents", {
    description:
      "Search ServiceNow incidents with filters. Use to find incidents by state, priority, assignment group, or description.",
    skipPermission: true,
    parameters: z.object({
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
      short_description_contains: z.string().optional().describe("Search text in short description"),
      unassigned_only: z
        .boolean()
        .optional()
        .describe("Only show incidents with no assignee (mutually exclusive with assigned_to)"),
      limit: z.number().optional().describe("Maximum results (default: 50, max: 200)")
    }),
    handler: async (a) => {
      try {
        if (a.unassigned_only && a.assigned_to) {
          return { error: "unassigned_only and assigned_to are mutually exclusive — pass only one." };
        }
        const incidents = await runtime.serviceNowClient.listIncidentsWithFilters({
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
      } catch (err) {
        return { error: String(err) };
      }
    }
  }),

  defineTool("get_incident", {
    description: "Get complete details of a specific incident by number (e.g., INC0012345)",
    skipPermission: true,
    parameters: z.object({
      number: z.string().describe("Incident number (e.g., INC0012345)")
    }),
    handler: async (a) => {
      try {
        const incident = await runtime.serviceNowClient.getIncidentByNumber(a.number);
        return incident ?? { error: `Incident ${a.number} not found` };
      } catch (err) {
        return { error: String(err) };
      }
    }
  }),

  defineTool("summarize_incident", {
    description:
      "Get incident details enriched with related changes and linked Azure DevOps work items. Use for incident analysis, triage, or handover.",
    skipPermission: true,
    parameters: z.object({
      number: z.string().describe("Incident number (e.g., INC0012345)")
    }),
    handler: async (a) => {
      try {
        const result = await runtime.incidentService.summarizeIncident(a.number);
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
      } catch (err) {
        return { error: String(err) };
      }
    }
  }),

  defineTool("search_changes", {
    description: "Search ServiceNow change records with filters",
    skipPermission: true,
    parameters: z.object({
      state_not: z
        .string()
        .optional()
        .describe(
          "Exclude changes with this state. Numeric change_request state code (e.g. '3'=Implement, '4'=Review), not a state name"
        ),
      assignment_group: z.string().optional().describe("Filter by assignment group"),
      configuration_item: z.string().optional().describe("Filter by configuration item"),
      started_after: z.string().optional().describe("Changes started after this date (ISO 8601)"),
      started_before: z.string().optional().describe("Changes started before this date (ISO 8601)"),
      risk: z.enum(["High", "Medium", "Low"]).optional().describe("Filter by risk level"),
      limit: z.number().optional().describe("Maximum results (default: 50)")
    }),
    handler: async (a) => {
      try {
        const changes = await runtime.serviceNowClient.listChangesWithFilters({
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
      } catch (err) {
        return { error: String(err) };
      }
    }
  }),

  defineTool("get_change", {
    description: "Get complete details of a specific change record by number (e.g., CHG0005432)",
    skipPermission: true,
    parameters: z.object({
      number: z.string().describe("Change number (e.g., CHG0005432)")
    }),
    handler: async (a) => {
      try {
        const change = await runtime.serviceNowClient.getChangeByNumber(a.number);
        return change ?? { error: `Change ${a.number} not found` };
      } catch (err) {
        return { error: String(err) };
      }
    }
  }),

  defineTool("correlate_changes", {
    description:
      "Find changes that may be related to an incident by configuration item, business service, assignment group, or time window",
    skipPermission: true,
    parameters: z.object({
      incident_number: z.string().describe("Incident to find related changes for"),
      window_hours_before: z
        .number()
        .optional()
        .describe("Hours before incident to search (default: 24)"),
      window_hours_after: z
        .number()
        .optional()
        .describe("Hours after incident to search (default: 4)")
    }),
    handler: async (a) => {
      try {
        // Build a per-call window only if the caller overrode either bound; otherwise
        // pass undefined so the service uses the configured CORRELATION_HOURS_* defaults.
        const defaults = runtime.config.thresholds.relatedChangeWindow;
        const window =
          a.window_hours_before !== undefined || a.window_hours_after !== undefined
            ? {
                beforeHours: a.window_hours_before ?? defaults.beforeHours,
                afterHours: a.window_hours_after ?? defaults.afterHours
              }
            : undefined;
        const relatedChanges = await runtime.incidentService.findRelatedChanges(
          a.incident_number,
          window
        );

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
      } catch (err) {
        return { error: String(err) };
      }
    }
  }),

  defineTool("find_sla_risks", {
    description:
      "Find open incidents at risk of SLA breach. Risk levels: Critical (<10% time), High (<25%), Medium (<50%)",
    skipPermission: true,
    parameters: z.object({
      assignment_group: z.string().optional().describe("Filter to specific team"),
      priorities: z
        .array(z.enum(["1", "2", "3", "4"]))
        .optional()
        .describe("Filter to specific priorities (e.g., ['1', '2'])"),
      risk_level: z
        .enum(["Critical", "High", "Medium"])
        .optional()
        .describe("Minimum risk level to include")
    }),
    handler: async (a) => {
      try {
        const risks = await runtime.incidentService.listSlaRisks({
          onlyOpen: true,
          assignmentGroup: a.assignment_group,
          priorities: a.priorities
        });

        let filteredRisks = risks;
        if (a.risk_level) {
          const riskOrder = { Critical: 0, High: 1, Medium: 2 };
          const minLevel = riskOrder[a.risk_level];
          filteredRisks = risks.filter((r) => riskOrder[r.riskLevel] <= minLevel);
        }

        return {
          count: filteredRisks.length,
          risks: filteredRisks.map((r) => ({
            incidentNumber: r.incidentNumber,
            priority: r.priority,
            assignmentGroup: r.assignmentGroup,
            slaDue: r.slaDue,
            remainingMinutes: r.remainingMinutes,
            riskLevel: r.riskLevel,
            suggestedAction: r.suggestedAction
          }))
        };
      } catch (err) {
        return { error: String(err) };
      }
    }
  }),

  defineTool("find_stale_tickets", {
    description:
      "Find tickets not updated within expected thresholds. Thresholds: P1=30min, P2=2h, P3=24h, P4=72h",
    skipPermission: true,
    parameters: z.object({
      assignment_group: z.string().optional().describe("Filter to specific team"),
      priorities: z
        .array(z.enum(["1", "2", "3", "4"]))
        .optional()
        .describe("Filter to specific priorities")
    }),
    handler: async (a) => {
      try {
        const staleTickets = await runtime.incidentService.listStaleIncidents({
          onlyOpen: true,
          assignmentGroup: a.assignment_group,
          priorities: a.priorities
        });

        return {
          count: staleTickets.length,
          tickets: staleTickets.map((t) => ({
            incidentNumber: t.incidentNumber,
            priority: t.priority,
            assignmentGroup: t.assignmentGroup,
            lastUpdated: t.lastUpdated,
            staleByMinutes: t.staleByMinutes,
            thresholdMinutes: t.thresholdMinutes
          }))
        };
      } catch (err) {
        return { error: String(err) };
      }
    }
  }),

  defineTool("generate_ops_summary", {
    description:
      "Generate a daily operations summary with key metrics, risks, and recommended actions",
    skipPermission: true,
    parameters: z.object({
      date: z.string().optional().describe("Date for summary (ISO 8601, default: today)"),
      assignment_group: z.string().optional().describe("Focus on specific team")
    }),
    handler: async (a) => {
      try {
        let now: Date | undefined;
        if (a.date) {
          const parsed = new Date(a.date);
          if (Number.isNaN(parsed.getTime())) {
            return { error: `Invalid date: ${a.date}. Use ISO 8601, e.g. 2026-06-11.` };
          }
          now = parsed;
        }
        const report = await runtime.reportService.generateDailyOpsReport({
          now,
          assignmentGroup: a.assignment_group
        });

        return {
          generatedAt: report.generatedAt,
          generatedForDate: report.generatedForDate,
          executiveSummary: report.executiveSummary,
          openIncidentsByPriority: report.openIncidentsByPriority,
          slaRisksCount: report.slaRisks.length,
          slaRisks: report.slaRisks.slice(0, 10).map((r) => ({
            incidentNumber: r.incidentNumber,
            priority: r.priority,
            remainingMinutes: r.remainingMinutes,
            riskLevel: r.riskLevel
          })),
          staleIncidentsCount: report.staleIncidents.length,
          staleIncidents: report.staleIncidents.slice(0, 10).map((t) => ({
            incidentNumber: t.incidentNumber,
            priority: t.priority,
            staleByMinutes: t.staleByMinutes
          })),
          majorIncidentsCount: report.majorIncidents.length,
          failedOrHighRiskChangesCount: report.failedOrHighRiskChanges.length,
          upcomingChangesCount: report.upcomingChanges.length,
          recommendedActions: report.recommendedActions
        };
      } catch (err) {
        return { error: String(err) };
      }
    }
  }),

  defineTool("search_work_items", {
    description: "Search Azure DevOps work items by text, type, state, area path, or assignee",
    skipPermission: true,
    parameters: z.object({
      query_text: z.string().optional().describe("Text to search for in the title (e.g., incident number)"),
      work_item_type: z
        .enum(["Bug", "Task", "User Story", "Issue"])
        .optional()
        .describe("Filter by work item type"),
      state: z.string().optional().describe("Filter by state (e.g., 'Active', 'Closed')"),
      area_path: z.string().optional().describe("Filter to work items UNDER this area path"),
      assigned_to: z.string().optional().describe("Filter by assignee email/display, or '@Me'")
    }),
    handler: async (a) => {
      try {
        const workItems = await runtime.azureDevOpsClient.searchWorkItems({
          text: a.query_text,
          workItemType: a.work_item_type,
          state: a.state,
          areaPath: a.area_path,
          assignedTo: a.assigned_to
        });

        return {
          count: workItems.length,
          workItems: workItems.map((w) => ({
            id: w.id,
            title: w.title,
            workItemType: w.workItemType,
            state: w.state,
            assignedTo: w.assignedTo,
            areaPath: w.areaPath,
            iterationPath: w.iterationPath,
            priority: w.priority,
            storyPoints: w.storyPoints
          }))
        };
      } catch (err) {
        return { error: String(err) };
      }
    }
  }),

  defineTool("get_work_item", {
    description: "Get a single Azure DevOps work item by its numeric ID",
    skipPermission: true,
    parameters: z.object({
      id: z.number().int().describe("Work item ID (e.g., 8533637)")
    }),
    handler: async (a) => {
      try {
        const workItem = await runtime.azureDevOpsClient.getWorkItem(a.id);
        return workItem ?? { error: `Work item ${a.id} not found` };
      } catch (err) {
        return { error: String(err) };
      }
    }
  }),

  defineTool("create_bug_from_incident", {
    description:
      "Create an Azure DevOps bug linked to a ServiceNow incident. Includes incident details, priority mapping, and standard acceptance criteria. This is a WRITE action and requires confirmation.",
    // No skipPermission: this write is gated by the permission handler.
    parameters: z.object({
      incident_number: z.string().describe("Incident to create bug from"),
      title_override: z
        .string()
        .optional()
        .describe("Custom title (default: uses incident short description)"),
      additional_tags: z.array(z.string()).optional().describe("Extra tags to add"),
      area_path: z.string().optional().describe("ADO area path (default: from config)"),
      iteration_path: z.string().optional().describe("ADO iteration path (default: from config)")
    }),
    handler: async (a) => {
      try {
        // Honor the create-bug feature flag (ADO_CREATE_BUG_ENABLED).
        if (!runtime.config.features.createAdoBug) {
          return { error: "ADO bug creation is disabled by feature flag." };
        }

        const summary = await runtime.incidentService.summarizeIncident(a.incident_number);

        const title =
          a.title_override ?? `[${summary.incident.number}] ${summary.incident.shortDescription}`;
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

        const tags = ["ServiceNow", "Incident", "SRE", ...(a.additional_tags ?? [])];

        const created = await runtime.azureDevOpsClient.createBug({
          title,
          description,
          areaPath: a.area_path ?? runtime.config.azureDevOps.defaultAreaPath,
          iterationPath: a.iteration_path ?? runtime.config.azureDevOps.defaultIterationPath,
          tags,
          assignedTeam: runtime.config.azureDevOps.defaultAssignedTeam,
          priority: summary.incident.priority,
          incidentNumber: a.incident_number
        });

        return {
          success: true,
          bugId: created.id,
          title: created.title,
          linkedIncident: a.incident_number,
          message: `Bug ${created.id} created successfully`
        };
      } catch (err) {
        return { error: String(err) };
      }
    }
  }),

  defineTool("search_knowledge", {
    description:
      "Search the internal documentation knowledge index (runbooks, wikis, KB) by meaning. Use to find a procedure, fix, or reference relevant to an incident. Returns ranked snippets with source URLs to cite.",
    skipPermission: true,
    parameters: z.object({
      query: z.string().describe("Natural-language search query"),
      k: z.number().optional().describe("Number of results (default 6, max 20)"),
      domain: z.string().optional().describe("Restrict to a single host, e.g. wiki.acme.io")
    }),
    handler: async (a) => {
      try {
        return await runtime.knowledge.search(a.query, a.k, a.domain);
      } catch (err) {
        return { error: String(err) };
      }
    }
  }),

  defineTool("index_url", {
    description:
      "Crawl and index a small set of internal pages starting from a URL into the knowledge index, then they become searchable via search_knowledge. Bounded (shallow, few pages) for use mid-conversation; use the `sre-agent crawl` CLI for full site ingest.",
    skipPermission: true,
    parameters: z.object({
      url: z.string().describe("Seed URL to crawl from (must be within an allowed domain)"),
      depth: z.number().optional().describe("Link-follow depth, clamped to 2"),
      max_pages: z.number().optional().describe("Max pages, clamped to 25")
    }),
    handler: async (a) => {
      try {
        const res = await runtime.knowledge.crawl(
          { seeds: [a.url], maxDepth: Math.min(a.depth ?? 1, 2), maxPages: Math.min(a.max_pages ?? 10, 25) },
          () => {}
        );
        return { pages_crawled: res.pagesCrawled, chunks_added: res.chunksAdded, skipped: res.pagesSkipped };
      } catch (err) {
        return { error: String(err) };
      }
    }
  })
];
