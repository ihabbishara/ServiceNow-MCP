import { fetch, RequestInit } from "undici";
import { WorkItem } from "../../types.js";
import { AdoConfig } from "../../config.js";
import { proxyDispatcher, FetchDispatcher } from "../proxy.js";
import type { AzureDevOpsClient, WorkItemSearchFilters, CreateBugPayload } from "./types.js";
import { mapAzWorkItem, AzWorkItemRaw } from "./map.js";
import { AzBoardsClient } from "./azBoards.js";

export type { AzureDevOpsClient, WorkItemSearchFilters, CreateBugPayload } from "./types.js";

interface AdoWorkItemRow {
  id: number;
  fields: Record<string, unknown> & {
    "System.Title"?: string;
    "System.State"?: string;
    "System.AssignedTo"?: { displayName?: string };
    "System.AreaPath"?: string;
    "System.Tags"?: string;
  };
}

const escapeWiql = (s: string): string => s.replace(/'/g, "''");

const mapWorkItem = (row: AdoWorkItemRow): WorkItem => ({
  id: row.id,
  title: row.fields["System.Title"] ?? "",
  state: row.fields["System.State"] ?? "",
  assignedTo: row.fields["System.AssignedTo"]?.displayName,
  areaPath: row.fields["System.AreaPath"],
  tags: row.fields["System.Tags"]?.split(";").map((t) => t.trim()).filter(Boolean)
});

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

  async searchWorkItems(f: WorkItemSearchFilters): Promise<WorkItem[]> {
    if (!this.cfg.enabled) return [];
    this.assertConfigured();

    const conditions: string[] = [];
    if (f.text) conditions.push(`[System.Title] CONTAINS '${escapeWiql(f.text)}'`);
    if (f.workItemType) conditions.push(`[System.WorkItemType] = '${escapeWiql(f.workItemType)}'`);
    if (f.state) conditions.push(`[System.State] = '${escapeWiql(f.state)}'`);
    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
    const query = `SELECT [System.Id] FROM WorkItems${where} ORDER BY [System.ChangedDate] DESC`;

    const wiql = await this.requestJson<{ workItems?: Array<{ id: number }> }>(
      this.apiUrl("wit/wiql?api-version=7.1&$top=50"),
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: this.authHeader },
        body: JSON.stringify({ query })
      }
    );
    const ids = (wiql.workItems ?? []).map((w) => w.id);
    if (!ids.length) return [];

    const fields = ["System.Title", "System.State", "System.AssignedTo", "System.AreaPath", "System.Tags"].join(",");
    const details = await this.requestJson<{ value?: AdoWorkItemRow[] }>(
      this.apiUrl(`wit/workitems?ids=${ids.join(",")}&fields=${fields}&api-version=7.1`),
      { headers: { Accept: "application/json", Authorization: this.authHeader } }
    );
    return (details.value ?? []).map(mapWorkItem);
  }

  async getWorkItem(id: number): Promise<WorkItem | null> {
    if (!this.cfg.enabled) return null;
    this.assertConfigured();
    if (!Number.isInteger(id)) throw new Error("work item id must be an integer");
    const row = await this.requestJson<AzWorkItemRaw>(
      this.apiUrl(`wit/workitems/${id}?$expand=fields&api-version=7.1`),
      { headers: { Accept: "application/json", Authorization: this.authHeader } }
    );
    return row ? mapAzWorkItem(row) : null;
  }

  async createBug(p: CreateBugPayload): Promise<{ id: number; title: string }> {
    if (!this.cfg.enabled) throw new Error("ADO integration is disabled");
    this.assertConfigured();

    const ops: Array<{ op: "add"; path: string; value: string | number }> = [
      { op: "add", path: "/fields/System.Title", value: p.title },
      { op: "add", path: "/fields/Microsoft.VSTS.TCM.ReproSteps", value: p.description.replace(/\n/g, "<br>") }
    ];
    const areaPath = p.areaPath ?? this.cfg.defaultAreaPath;
    const iterationPath = p.iterationPath ?? this.cfg.defaultIterationPath;
    if (areaPath) ops.push({ op: "add", path: "/fields/System.AreaPath", value: areaPath });
    if (iterationPath) ops.push({ op: "add", path: "/fields/System.IterationPath", value: iterationPath });
    if (p.tags?.length) ops.push({ op: "add", path: "/fields/System.Tags", value: p.tags.join("; ") });
    // ServiceNow priority "1".."4" maps directly to ADO's 1 (highest) .. 4 (lowest).
    const priority = p.priority ? Number(p.priority) : NaN;
    if (Number.isInteger(priority) && priority >= 1 && priority <= 4) {
      ops.push({ op: "add", path: "/fields/Microsoft.VSTS.Common.Priority", value: priority });
    }

    const created = await this.requestJson<{ id: number; fields: { "System.Title": string } }>(
      this.apiUrl("wit/workitems/$Bug?api-version=7.1"),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json-patch+json",
          Accept: "application/json",
          Authorization: this.authHeader
        },
        body: JSON.stringify(ops)
      }
    );
    return { id: created.id, title: created.fields["System.Title"] };
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
