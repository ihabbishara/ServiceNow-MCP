import { defineTool } from "@github/copilot-sdk";
import { z } from "zod";
import { TOOL_SPECS, ToolError } from "@sre/core";
import type { McpRuntime, ToolSpec } from "@sre/core";

/**
 * Copilot adapter over the core tool registry. Read tools skip the permission
 * gate; write tools (spec.write) surface a permission request handled by
 * makePermissionHandler. Handlers never throw: expected failures (ToolError)
 * and unexpected errors both come back as { error } so the model sees a
 * structured error instead of the turn failing.
 */
export const toCopilotTool = (spec: ToolSpec, runtime: McpRuntime) =>
  defineTool(spec.name, {
    description: spec.description,
    skipPermission: !spec.write,
    parameters: z.object(spec.schema),
    handler: async (args: unknown) => {
      try {
        const disabled = spec.enabledWhen?.(runtime.config);
        if (disabled) return { error: disabled };
        return await spec.run(runtime, args as never);
      } catch (err) {
        return { error: err instanceof ToolError ? err.message : String(err) };
      }
    }
  });

/** Tools not yet migrated to the core registry — shrinks to [] by Task 7, then this scaffold is deleted. */
const legacyTools = (runtime: McpRuntime) => [
  defineTool("search_work_items", {
    description: "Search Azure DevOps work items by text, type, state, area path, or assignee",
    skipPermission: true,
    parameters: z.object({
      query_text: z
        .string()
        .optional()
        .describe("Text to search for in the title (e.g., incident number)"),
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

  defineTool("get_incident_documents", {
    description:
      "Fetch an incident's supporting documents from SharePoint by incident number (e.g. INC123456). " +
      "Recursively reads the incident folder's Docs subtree (docx/xlsx/pptx/pdf) and returns extracted " +
      "text to read and cite. Use when the user references an incident and asks about its docs, runbook, " +
      "postmortem, or details that live in SharePoint rather than ServiceNow.",
    skipPermission: true,
    parameters: z.object({
      incident: z.string().describe("Incident number, e.g. INC123456")
    }),
    handler: async (a) => {
      try {
        if (!runtime.sharePoint) {
          return { error: "SharePoint integration is disabled (set SHAREPOINT_ENABLED=true)." };
        }
        return await runtime.sharePoint.getIncidentDocuments(a.incident);
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
          {
            seeds: [a.url],
            maxDepth: Math.min(a.depth ?? 1, 2),
            maxPages: Math.min(a.max_pages ?? 10, 25)
          },
          () => {}
        );
        return {
          pages_crawled: res.pagesCrawled,
          chunks_added: res.chunksAdded,
          skipped: res.pagesSkipped
        };
      } catch (err) {
        return { error: String(err) };
      }
    }
  })
];

export const buildTools = (runtime: McpRuntime) => [
  ...TOOL_SPECS.map((s) => toCopilotTool(s, runtime)),
  ...legacyTools(runtime)
];
