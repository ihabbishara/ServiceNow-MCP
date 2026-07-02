import { fetch, RequestInit } from "undici";
import { WorkItem } from "../../types.js";
import { AdoConfig } from "../../config.js";
import { proxyDispatcher, FetchDispatcher } from "../proxy.js";
import type {
  AzureDevOpsClient,
  WorkItemSearchFilters,
  CreateBugPayload,
  CreateWorkItemPayload
} from "./types.js";
import { mapAzWorkItem, AzWorkItemRaw } from "./map.js";
import { AzBoardsClient } from "./azBoards.js";
import { searchConditions } from "./wiql.js";
import { workItemFieldOps } from "./fields.js";

export type {
  AzureDevOpsClient,
  WorkItemSearchFilters,
  CreateBugPayload,
  CreateWorkItemPayload
} from "./types.js";

export class AdoPatClient implements AzureDevOpsClient {
  private readonly dispatcher?: FetchDispatcher;

  constructor(private readonly cfg: AdoConfig) {
    this.dispatcher = proxyDispatcher(cfg.proxyUrl);
  }

  private get authHeader(): string {
    return "Basic " + Buffer.from(`:${this.cfg.pat ?? ""}`).toString("base64");
  }

  private apiUrl(path: string): string {
    return `${this.cfg.orgUrl}/${encodeURIComponent(this.cfg.project ?? "")}/_apis/${path}`;
  }

  private assertConfigured(): void {
    if (!this.cfg.orgUrl || !this.cfg.project) {
      throw new Error("ADO client is enabled but orgUrl/project are not configured");
    }
  }

  private async requestJson<T>(url: string, init: RequestInit): Promise<T> {
    const res = await fetch(url, { ...init, dispatcher: this.dispatcher });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      throw new Error(`Azure DevOps request failed: ${res.status} ${body}`);
    }
    return (await res.json()) as T;
  }

  private static readonly SEARCH_FIELDS = [
    "System.Title",
    "System.State",
    "System.WorkItemType",
    "System.AssignedTo",
    "System.AreaPath",
    "System.IterationPath",
    "System.Tags",
    "System.Parent",
    "Microsoft.VSTS.Common.Priority",
    "Microsoft.VSTS.Scheduling.StoryPoints"
  ].join(",");

  async searchWorkItems(f: WorkItemSearchFilters): Promise<WorkItem[]> {
    if (!this.cfg.enabled) return [];
    this.assertConfigured();

    const conditions = searchConditions(f);
    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
    const query = `SELECT [System.Id] FROM WorkItems${where} ORDER BY [System.ChangedDate] DESC`;
    const limit = Math.min(f.limit ?? 50, 200);

    const wiql = await this.requestJson<{ workItems?: Array<{ id: number }> }>(
      this.apiUrl(`wit/wiql?api-version=7.1&$top=${limit}`),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: this.authHeader
        },
        body: JSON.stringify({ query })
      }
    );
    const ids = (wiql.workItems ?? []).map((w) => w.id);
    if (!ids.length) return [];

    const details = await this.requestJson<{ value?: AzWorkItemRaw[] }>(
      this.apiUrl(
        `wit/workitems?ids=${ids.join(",")}&fields=${AdoPatClient.SEARCH_FIELDS}&api-version=7.1`
      ),
      { headers: { Accept: "application/json", Authorization: this.authHeader } }
    );
    return (details.value ?? []).map(mapAzWorkItem);
  }

  async getWorkItem(id: number): Promise<WorkItem | null> {
    if (!this.cfg.enabled) return null;
    this.assertConfigured();
    if (!Number.isInteger(id)) throw new Error("work item id must be an integer");
    const row = await this.requestJson<AzWorkItemRaw>(
      this.apiUrl(`wit/workitems/${id}?$expand=fields&api-version=7.1`),
      { headers: { Accept: "application/json", Authorization: this.authHeader } }
    );
    // A missing work item makes the REST call return non-2xx (requestJson
    // throws); the null branch only guards an explicit null/empty response.
    return row ? mapAzWorkItem(row) : null;
  }

  private buildCreateOps(
    p: CreateWorkItemPayload
  ): Array<{ op: "add"; path: string; value: string | number }> {
    const ops: Array<{ op: "add"; path: string; value: string | number }> = [
      { op: "add", path: "/fields/System.Title", value: p.title }
    ];
    const areaPath = p.areaPath ?? this.cfg.defaultAreaPath;
    const iterationPath = p.iterationPath ?? this.cfg.defaultIterationPath;
    if (areaPath) ops.push({ op: "add", path: "/fields/System.AreaPath", value: areaPath });
    if (iterationPath)
      ops.push({ op: "add", path: "/fields/System.IterationPath", value: iterationPath });
    if (p.assignedTo)
      ops.push({ op: "add", path: "/fields/System.AssignedTo", value: p.assignedTo });
    for (const f of workItemFieldOps(p))
      ops.push({ op: "add", path: `/fields/${f.referenceName}`, value: f.value });
    return ops;
  }

  async createWorkItem(p: CreateWorkItemPayload): Promise<WorkItem> {
    if (!this.cfg.enabled) throw new Error("ADO integration is disabled");
    this.assertConfigured();
    const created = await this.requestJson<AzWorkItemRaw>(
      this.apiUrl(`wit/workitems/$${encodeURIComponent(p.type)}?api-version=7.1`),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json-patch+json",
          Accept: "application/json",
          Authorization: this.authHeader
        },
        body: JSON.stringify(this.buildCreateOps(p))
      }
    );
    return mapAzWorkItem(created);
  }

  async getWorkItemFields(id: number): Promise<Record<string, unknown> | null> {
    if (!this.cfg.enabled) return null;
    this.assertConfigured();
    if (!Number.isInteger(id)) throw new Error("work item id must be an integer");
    const row = await this.requestJson<AzWorkItemRaw>(
      this.apiUrl(`wit/workitems/${id}?$expand=fields&api-version=7.1`),
      { headers: { Accept: "application/json", Authorization: this.authHeader } }
    );
    return row?.fields ?? null;
  }

  async listChildren(parentId: number): Promise<number[]> {
    if (!this.cfg.enabled) return [];
    this.assertConfigured();
    if (!Number.isInteger(parentId)) throw new Error("parent id must be an integer");
    const query = `SELECT [System.Id] FROM WorkItems WHERE [System.Parent] = ${parentId} ORDER BY [System.Id]`;
    const wiql = await this.requestJson<{ workItems?: Array<{ id: number }> }>(
      this.apiUrl("wit/wiql?api-version=7.1"),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: this.authHeader
        },
        body: JSON.stringify({ query })
      }
    );
    return (wiql.workItems ?? []).map((w) => w.id);
  }

  async addRelation(fromId: number, toId: number, relType: "parent" | "related"): Promise<void> {
    if (!Number.isInteger(fromId) || !Number.isInteger(toId))
      throw new Error("work item ids must be integers");
    if (!this.cfg.enabled) throw new Error("ADO integration is disabled");
    this.assertConfigured();
    const rel =
      relType === "parent" ? "System.LinkTypes.Hierarchy-Reverse" : "System.LinkTypes.Related";
    const targetUrl = `${this.cfg.orgUrl}/_apis/wit/workitems/${toId}`;
    const ops = [{ op: "add", path: "/relations/-", value: { rel, url: targetUrl } }];
    await this.requestJson<AzWorkItemRaw>(this.apiUrl(`wit/workitems/${fromId}?api-version=7.1`), {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json-patch+json",
        Accept: "application/json",
        Authorization: this.authHeader
      },
      body: JSON.stringify(ops)
    });
  }

  async createBug(p: CreateBugPayload): Promise<{ id: number; title: string }> {
    const wi = await this.createWorkItem({
      type: "Bug",
      title: p.title,
      description: p.description,
      areaPath: p.areaPath,
      iterationPath: p.iterationPath,
      tags: p.tags,
      priority: p.priority
    });
    return { id: wi.id, title: wi.title };
  }
}

/**
 * Build the appropriate ADO client. Lenient by design: mcp-server eagerly
 * builds the runtime with no ADO env and must still start (it fails fast only
 * on missing ServiceNow vars). So this factory never throws.
 * - azcli mode WITH orgUrl + project → AzBoardsClient (no-PAT, via `az boards`).
 * - otherwise → AdoPatClient (inert when not enabled/configured: searchWorkItems
 *   returns [], createBug throws "disabled"). The agent-side requirement that
 *   azcli needs org/project is enforced in sre-agent's loadAgentConfig.
 */
export const createAdoClient = (cfg: AdoConfig): AzureDevOpsClient => {
  if (cfg.authMode === "azcli" && cfg.orgUrl && cfg.project) {
    return new AzBoardsClient({
      orgUrl: cfg.orgUrl,
      project: cfg.project,
      azPath: cfg.azPath ?? "az",
      defaultAreaPath: cfg.defaultAreaPath,
      defaultIterationPath: cfg.defaultIterationPath,
      createBugEnabled: cfg.createBugEnabled ?? true
    });
  }
  return new AdoPatClient(cfg);
};
