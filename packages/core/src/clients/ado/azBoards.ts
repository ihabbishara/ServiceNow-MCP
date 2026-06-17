import type { AzureDevOpsClient, WorkItemSearchFilters, CreateBugPayload } from "./types.js";
import type { WorkItem } from "../../types.js";
import { AzRunner } from "./az.js";
import { mapAzWorkItem, AzWorkItemRaw } from "./map.js";

export interface AzBoardsConfig {
  orgUrl: string;
  project: string;
  azPath: string;
  defaultAreaPath?: string;
  defaultIterationPath?: string;
  createBugEnabled: boolean;
}

const SELECT = [
  "[System.Id]",
  "[System.Title]",
  "[System.State]",
  "[System.WorkItemType]",
  "[System.AssignedTo]",
  "[System.AreaPath]",
  "[System.IterationPath]",
  "[System.Tags]",
  "[System.Parent]",
  "[Microsoft.VSTS.Common.Priority]",
  "[Microsoft.VSTS.Scheduling.StoryPoints]"
].join(", ");

const esc = (s: string): string => s.replace(/'/g, "''");

export class AzBoardsClient implements AzureDevOpsClient {
  private readonly runner: AzRunner;

  constructor(private readonly cfg: AzBoardsConfig, runner?: AzRunner) {
    this.runner = runner ?? new AzRunner(cfg.azPath);
  }

  async searchWorkItems(f: WorkItemSearchFilters): Promise<WorkItem[]> {
    const where: string[] = ["[System.TeamProject] = @project"];
    if (f.text) where.push(`[System.Title] CONTAINS '${esc(f.text)}'`);
    if (f.workItemType) where.push(`[System.WorkItemType] = '${esc(f.workItemType)}'`);
    if (f.state) where.push(`[System.State] = '${esc(f.state)}'`);
    if (f.areaPath) where.push(`[System.AreaPath] UNDER '${esc(f.areaPath)}'`);
    if (f.assignedTo === "@Me") where.push("[System.AssignedTo] = @Me");
    else if (f.assignedTo) where.push(`[System.AssignedTo] = '${esc(f.assignedTo)}'`);

    const wiql = `SELECT ${SELECT} FROM workitems WHERE ${where.join(" AND ")} ORDER BY [System.ChangedDate] DESC`;
    const rows = await this.runner.json<AzWorkItemRaw[]>([
      "boards", "query", "--wiql", wiql, "--org", this.cfg.orgUrl, "--project", this.cfg.project
    ]);
    const limit = Math.min(f.limit ?? 50, 200);
    return (rows ?? []).slice(0, limit).map(mapAzWorkItem);
  }

  async getWorkItem(id: number): Promise<WorkItem | null> {
    if (!Number.isInteger(id)) throw new Error("work item id must be an integer");
    const row = await this.runner.json<AzWorkItemRaw | null>([
      "boards", "work-item", "show", "--id", String(id), "--expand", "fields", "--org", this.cfg.orgUrl
    ]);
    // A missing work item makes `az` exit non-zero (AzRunner throws); the null
    // branch only guards an explicit null/empty response, never "not found".
    return row ? mapAzWorkItem(row) : null;
  }

  async createBug(p: CreateBugPayload): Promise<{ id: number; title: string }> {
    if (!this.cfg.createBugEnabled) throw new Error("ADO bug creation is disabled");
    const area = p.areaPath ?? this.cfg.defaultAreaPath;
    const iter = p.iterationPath ?? this.cfg.defaultIterationPath;

    const fields: string[] = [];
    if (p.tags?.length) fields.push(`System.Tags=${p.tags.join("; ")}`);
    const prio = p.priority ? Number(p.priority) : NaN;
    if (Number.isInteger(prio) && prio >= 1 && prio <= 4) fields.push(`Microsoft.VSTS.Common.Priority=${prio}`);
    fields.push(`Microsoft.VSTS.TCM.ReproSteps=${p.description.replace(/\n/g, "<br>")}`);

    const args = [
      "boards", "work-item", "create", "--type", "Bug", "--title", p.title,
      "--org", this.cfg.orgUrl, "--project", this.cfg.project
    ];
    if (area) args.push("--area", area);
    if (iter) args.push("--iteration", iter);
    if (fields.length) args.push("--fields", ...fields);

    const row = await this.runner.json<AzWorkItemRaw>(args);
    return { id: row.id, title: row.fields?.["System.Title"] ?? p.title };
  }
}
