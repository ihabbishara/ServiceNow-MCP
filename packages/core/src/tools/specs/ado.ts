import { z } from "zod";
import type { AppConfig } from "../../config.js";
import { ToolError, defineSpec } from "../spec.js";

const ADO_DISABLED = "Azure DevOps integration is disabled. Set ADO_ENABLED=true.";

const adoEnabled = (c: AppConfig): string | null => (c.azureDevOps.enabled ? null : ADO_DISABLED);

export const adoSpecs = [
  defineSpec({
    name: "search_work_items",
    description: "Search Azure DevOps work items by text, type, state, area path, or assignee",
    schema: {
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
    },
    enabledWhen: (c) =>
      c.azureDevOps.enabled
        ? null
        : "Azure DevOps integration is disabled. Set ADO_ENABLED=true to search work items.",
    run: async (rt, a) => {
      const workItems = await rt.azureDevOpsClient.searchWorkItems({
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
          storyPoints: w.storyPoints,
          tags: w.tags
        }))
      };
    }
  }),

  defineSpec({
    name: "get_work_item",
    description: "Get a single Azure DevOps work item by its numeric ID",
    schema: {
      id: z.number().int().describe("Work item ID (e.g., 8533637)")
    },
    enabledWhen: adoEnabled,
    run: async (rt, a) => {
      const workItem = await rt.azureDevOpsClient.getWorkItem(a.id);
      if (!workItem) throw new ToolError(`Work item ${a.id} not found`);
      return workItem;
    }
  }),

  defineSpec({
    name: "create_bug_from_incident",
    description:
      "Create an Azure DevOps bug linked to a ServiceNow incident. Includes incident details, priority mapping, and standard acceptance criteria. This is a WRITE action and requires confirmation.",
    write: true,
    schema: {
      incident_number: z.string().describe("Incident to create bug from"),
      title_override: z
        .string()
        .optional()
        .describe("Custom title (default: uses incident short description)"),
      additional_tags: z.array(z.string()).optional().describe("Extra tags to add"),
      area_path: z.string().optional().describe("ADO area path (default: from config)"),
      iteration_path: z.string().optional().describe("ADO iteration path (default: from config)")
    },
    enabledWhen: (c) =>
      !c.azureDevOps.enabled
        ? "ADO integration is disabled. Enable it to create bugs."
        : !c.features.createAdoBug
          ? "ADO bug creation is disabled by feature flag."
          : null,
    run: async (rt, a) => {
      const summary = await rt.incidentService.summarizeIncident(a.incident_number);

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

      const created = await rt.azureDevOpsClient.createBug({
        title,
        description,
        areaPath: a.area_path ?? rt.config.azureDevOps.defaultAreaPath,
        iterationPath: a.iteration_path ?? rt.config.azureDevOps.defaultIterationPath,
        tags,
        assignedTeam: rt.config.azureDevOps.defaultAssignedTeam,
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
    }
  }),

  defineSpec({
    name: "create_work_item",
    description:
      "Create an Azure DevOps work item (User Story, Task, Bug, Feature, Epic, Issue) on a board/backlog. Target the board via `board` (friendly name, resolved to an area path) or an explicit `area_path`. Optionally link under a parent work item.",
    write: true,
    schema: {
      type: z
        .enum(["User Story", "Task", "Bug", "Feature", "Epic", "Issue"])
        .describe("Work item type"),
      title: z.string().describe("Work item title"),
      description: z.string().optional().describe("Body/description"),
      board: z
        .string()
        .optional()
        .describe("Friendly board/team name, resolved to an area path via config"),
      area_path: z.string().optional().describe("Explicit ADO area path (overrides board)"),
      iteration_path: z.string().optional().describe("ADO iteration/sprint path"),
      tags: z.array(z.string()).optional().describe("Tags"),
      assigned_to: z.string().optional().describe("Assignee email/display name"),
      priority: z.enum(["1", "2", "3", "4"]).optional().describe("Priority 1 (highest) - 4"),
      story_points: z.number().optional().describe("Story points"),
      parent_id: z.number().optional().describe("Existing work item id to link this under (parent)")
    },
    enabledWhen: adoEnabled,
    run: async (rt, a) => {
      const boardWarning =
        a.board && !a.area_path && !rt.workItemService.isBoardKnown(a.board)
          ? `board "${a.board}" was not found in ADO_BOARD_MAP; used the default area path`
          : undefined;
      const wi = await rt.workItemService.create({
        type: a.type,
        title: a.title,
        description: a.description,
        board: a.board,
        areaPath: a.area_path,
        iterationPath: a.iteration_path,
        tags: a.tags,
        assignedTo: a.assigned_to,
        priority: a.priority,
        storyPoints: a.story_points,
        parentId: a.parent_id
      });
      return {
        success: true,
        id: wi.id,
        title: wi.title,
        type: wi.workItemType,
        areaPath: wi.areaPath,
        parentId: a.parent_id,
        ...(boardWarning ? { boardWarning } : {})
      };
    }
  }),

  defineSpec({
    name: "clone_work_item",
    description:
      "Clone an existing Azure DevOps work item to another board. Carries over fields (title, description, tags, priority, story points, acceptance criteria), resets state to New and clears the assignee. Optionally copies child tasks and adds a Related link back to the source.",
    write: true,
    schema: {
      source_id: z.number().describe("Work item id to clone"),
      board: z.string().optional().describe("Target board/team name, resolved to an area path"),
      area_path: z.string().optional().describe("Explicit target area path (overrides board)"),
      iteration_path: z.string().optional().describe("Target iteration/sprint path"),
      include_children: z.boolean().optional().describe("Copy child tasks too (default false)"),
      link_to_source: z
        .boolean()
        .optional()
        .describe("Add a Related link back to the source (default false)"),
      title_prefix: z
        .string()
        .optional()
        .describe("Prefix prepended to the cloned title (e.g. '[CLONE] ')"),
      overrides: z
        .object({
          title: z.string().optional(),
          description: z.string().optional(),
          tags: z.array(z.string()).optional(),
          assigned_to: z.string().optional(),
          priority: z.enum(["1", "2", "3", "4"]).optional(),
          story_points: z.number().optional()
        })
        .optional()
        .describe("Field overrides applied on top of the carried-over source fields")
    },
    enabledWhen: adoEnabled,
    run: async (rt, a) => {
      const boardWarning =
        a.board && !a.area_path && !rt.workItemService.isBoardKnown(a.board)
          ? `board "${a.board}" was not found in ADO_BOARD_MAP; used the default area path`
          : undefined;
      const o = a.overrides;
      const res = await rt.workItemService.clone({
        sourceId: a.source_id,
        board: a.board,
        areaPath: a.area_path,
        iterationPath: a.iteration_path,
        includeChildren: a.include_children,
        linkToSource: a.link_to_source,
        titlePrefix: a.title_prefix,
        overrides: o
          ? {
              type: undefined,
              title: o.title,
              description: o.description,
              tags: o.tags,
              assignedTo: o.assigned_to,
              priority: o.priority,
              storyPoints: o.story_points
            }
          : undefined
      });
      return { success: true, ...res, ...(boardWarning ? { boardWarning } : {}) };
    }
  })
];
