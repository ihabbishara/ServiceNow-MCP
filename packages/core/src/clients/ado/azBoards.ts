import type {
  AzureDevOpsClient,
  WorkItemSearchFilters,
  CreateBugPayload,
  CreateWorkItemPayload
} from "./types.js";
import type { WorkItem } from "../../types.js";
import { AzRunner } from "./az.js";
import { mapAzWorkItem, AzWorkItemRaw } from "./map.js";
import { searchConditions } from "./wiql.js";
import { workItemFieldOps } from "./fields.js";

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

export class AzBoardsClient implements AzureDevOpsClient {
  private readonly runner: AzRunner;

  constructor(
    private readonly cfg: AzBoardsConfig,
    runner?: AzRunner
  ) {
    this.runner = runner ?? new AzRunner(cfg.azPath);
  }

  async searchWorkItems(f: WorkItemSearchFilters): Promise<WorkItem[]> {
    const limit = Math.min(f.limit ?? 50, 200);
    const where = ["[System.TeamProject] = @project", ...searchConditions(f)];

    const wiql = `SELECT TOP ${limit} ${SELECT} FROM workitems WHERE ${where.join(" AND ")} ORDER BY [System.ChangedDate] DESC`;
    const rows = await this.runner.json<AzWorkItemRaw[]>([
      "boards",
      "query",
      "--wiql",
      wiql,
      "--org",
      this.cfg.orgUrl,
      "--project",
      this.cfg.project
    ]);
    return (rows ?? []).slice(0, limit).map(mapAzWorkItem);
  }

  async getWorkItem(id: number): Promise<WorkItem | null> {
    if (!Number.isInteger(id)) throw new Error("work item id must be an integer");
    const row = await this.runner.json<AzWorkItemRaw | null>([
      "boards",
      "work-item",
      "show",
      "--id",
      String(id),
      "--expand",
      "fields",
      "--org",
      this.cfg.orgUrl
    ]);
    // A missing work item makes `az` exit non-zero (AzRunner throws); the null
    // branch only guards an explicit null/empty response, never "not found".
    return row ? mapAzWorkItem(row) : null;
  }

  async createWorkItem(p: CreateWorkItemPayload): Promise<WorkItem> {
    const area = p.areaPath ?? this.cfg.defaultAreaPath;
    const iter = p.iterationPath ?? this.cfg.defaultIterationPath;
    const fields = workItemFieldOps(p).map((op) => `${op.referenceName}=${op.value}`);

    const args = [
      "boards",
      "work-item",
      "create",
      "--type",
      p.type,
      "--title",
      p.title,
      "--org",
      this.cfg.orgUrl,
      "--project",
      this.cfg.project
    ];
    if (area) args.push("--area", area);
    if (iter) args.push("--iteration", iter);
    if (p.assignedTo) args.push("--assigned-to", p.assignedTo);
    if (fields.length) args.push("--fields", ...fields);

    const row = await this.runner.json<AzWorkItemRaw>(args);
    return mapAzWorkItem(row);
  }

  async getWorkItemFields(id: number): Promise<Record<string, unknown> | null> {
    if (!Number.isInteger(id)) throw new Error("work item id must be an integer");
    const row = await this.runner.json<AzWorkItemRaw | null>([
      "boards",
      "work-item",
      "show",
      "--id",
      String(id),
      "--expand",
      "fields",
      "--org",
      this.cfg.orgUrl
    ]);
    return row?.fields ?? null;
  }

  async listChildren(parentId: number): Promise<number[]> {
    if (!Number.isInteger(parentId)) throw new Error("parent id must be an integer");
    const wiql = `SELECT TOP 500 [System.Id] FROM WorkItems WHERE [System.Parent] = ${parentId} ORDER BY [System.Id]`;
    const rows = await this.runner.json<Array<{ id: number }>>([
      "boards",
      "query",
      "--wiql",
      wiql,
      "--org",
      this.cfg.orgUrl,
      "--project",
      this.cfg.project
    ]);
    return (rows ?? []).map((r) => r.id);
  }

  async addRelation(fromId: number, toId: number, relType: "parent" | "related"): Promise<void> {
    if (!Number.isInteger(fromId) || !Number.isInteger(toId))
      throw new Error("work item ids must be integers");
    await this.runner.json([
      "boards",
      "work-item",
      "relation",
      "add",
      "--id",
      String(fromId),
      "--relation-type",
      relType,
      "--target-id",
      String(toId),
      "--org",
      this.cfg.orgUrl
    ]);
  }

  async createBug(p: CreateBugPayload): Promise<{ id: number; title: string }> {
    if (!this.cfg.createBugEnabled) throw new Error("ADO bug creation is disabled");
    const wi = await this.createWorkItem({
      type: "Bug",
      title: p.title,
      description: p.description,
      areaPath: p.areaPath,
      iterationPath: p.iterationPath,
      tags: p.tags,
      priority: p.priority
    });
    return { id: wi.id, title: wi.title || p.title };
  }
}
