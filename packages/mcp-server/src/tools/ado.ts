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

  // create_work_item - Create any ADO work item type on a board/backlog
  server.tool(
    "create_work_item",
    "Create an Azure DevOps work item (User Story, Task, Bug, Feature, Epic, Issue) on a board/backlog. Target the board via `board` (friendly name, resolved to an area path) or an explicit `area_path`. Optionally link under a parent work item.",
    {
      type: z.enum(["User Story", "Task", "Bug", "Feature", "Epic", "Issue"]).describe("Work item type"),
      title: z.string().describe("Work item title"),
      description: z.string().optional().describe("Body/description"),
      board: z.string().optional().describe("Friendly board/team name, resolved to an area path via config"),
      area_path: z.string().optional().describe("Explicit ADO area path (overrides board)"),
      iteration_path: z.string().optional().describe("ADO iteration/sprint path"),
      tags: z.array(z.string()).optional().describe("Tags"),
      assigned_to: z.string().optional().describe("Assignee email/display name"),
      priority: z.enum(["1", "2", "3", "4"]).optional().describe("Priority 1 (highest) - 4"),
      story_points: z.number().optional().describe("Story points"),
      parent_id: z.number().optional().describe("Existing work item id to link this under (parent)")
    },
    async (args) => {
      try {
        if (!runtime.config.azureDevOps.enabled) {
          return { content: [{ type: "text", text: "Azure DevOps integration is disabled. Set ADO_ENABLED=true." }], isError: true };
        }
        const boardWarning =
          args.board && !args.area_path && !runtime.workItemService.isBoardKnown(args.board)
            ? `board "${args.board}" was not found in ADO_BOARD_MAP; used the default area path`
            : undefined;
        const wi = await runtime.workItemService.create({
          type: args.type,
          title: args.title,
          description: args.description,
          board: args.board,
          areaPath: args.area_path,
          iterationPath: args.iteration_path,
          tags: args.tags,
          assignedTo: args.assigned_to,
          priority: args.priority,
          storyPoints: args.story_points,
          parentId: args.parent_id
        });
        return { content: [{ type: "text", text: JSON.stringify({ success: true, id: wi.id, title: wi.title, type: wi.workItemType, areaPath: wi.areaPath, parentId: args.parent_id, ...(boardWarning ? { boardWarning } : {}) }, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error creating work item: ${error}` }], isError: true };
      }
    }
  );

  // clone_work_item - Clone a work item to another board
  server.tool(
    "clone_work_item",
    "Clone an existing Azure DevOps work item to another board. Carries over fields (title, description, tags, priority, story points, acceptance criteria), resets state to New and clears the assignee. Optionally copies child tasks and adds a Related link back to the source.",
    {
      source_id: z.number().describe("Work item id to clone"),
      board: z.string().optional().describe("Target board/team name, resolved to an area path"),
      area_path: z.string().optional().describe("Explicit target area path (overrides board)"),
      iteration_path: z.string().optional().describe("Target iteration/sprint path"),
      include_children: z.boolean().optional().describe("Copy child tasks too (default false)"),
      link_to_source: z.boolean().optional().describe("Add a Related link back to the source (default false)"),
      title_prefix: z.string().optional().describe("Prefix prepended to the cloned title (e.g. '[CLONE] ')"),
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
    async (args) => {
      try {
        if (!runtime.config.azureDevOps.enabled) {
          return { content: [{ type: "text", text: "Azure DevOps integration is disabled. Set ADO_ENABLED=true." }], isError: true };
        }
        const boardWarning =
          args.board && !args.area_path && !runtime.workItemService.isBoardKnown(args.board)
            ? `board "${args.board}" was not found in ADO_BOARD_MAP; used the default area path`
            : undefined;
        const o = args.overrides;
        const res = await runtime.workItemService.clone({
          sourceId: args.source_id,
          board: args.board,
          areaPath: args.area_path,
          iterationPath: args.iteration_path,
          includeChildren: args.include_children,
          linkToSource: args.link_to_source,
          titlePrefix: args.title_prefix,
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
        return { content: [{ type: "text", text: JSON.stringify({ success: true, ...res, ...(boardWarning ? { boardWarning } : {}) }, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error cloning work item: ${error}` }], isError: true };
      }
    }
  );
};
