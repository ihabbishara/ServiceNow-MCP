import { fetch } from "undici";
import { Incident, ChangeRecord } from "../types.js";
import { ServiceNowConfig } from "../config.js";
import { proxyDispatcher, FetchDispatcher } from "./proxy.js";

interface SnField {
  value: string;
  display_value: string;
}
type SnRow = Record<string, SnField | undefined>;

const INCIDENT_FIELDS = [
  "number", "sys_id", "priority", "state", "short_description", "description",
  "assigned_to", "assignment_group", "business_service", "cmdb_ci",
  "opened_at", "sys_updated_on", "resolved_at", "sla_due", "work_notes", "comments"
].join(",");

const CHANGE_FIELDS = [
  "number", "sys_id", "state", "type", "risk", "impact", "short_description", "description",
  "assigned_to", "assignment_group", "business_service", "cmdb_ci",
  "start_date", "end_date", "work_start", "work_end",
  "implementation_plan", "backout_plan", "test_plan", "close_code", "close_notes"
].join(",");

// Default incident state codes: 6=Resolved, 7=Closed, 8=Canceled
const OPEN_INCIDENT_QUERY = "stateNOT IN6,7,8";

const STATE_CODES: Record<string, string> = {
  new: "1", "in progress": "2", "on hold": "3", resolved: "6", closed: "7", canceled: "8", cancelled: "8"
};
const stateCode = (state: string): string => STATE_CODES[state.toLowerCase()] ?? state;

// ^ is the encoded-query separator; strip it from free-text values so a value can't inject conditions
const snSafe = (v: string): string => v.replace(/\^/g, "");

const display = (row: SnRow, key: string): string | undefined => row[key]?.display_value || undefined;

// SN "value" timestamps are UTC "YYYY-MM-DD HH:MM:SS" (exactly one space; String.replace replaces first occurrence only)
const isoDate = (row: SnRow, key: string): string | undefined => {
  const v = row[key]?.value;
  return v ? `${v.replace(" ", "T")}Z` : undefined;
};

// Journal fields: display_value holds the latest entry text (best-effort; full history needs sys_journal_field)
const journal = (row: SnRow, key: string): string[] | undefined => {
  const v = row[key]?.display_value;
  return v ? [v] : undefined;
};

const toSnDateTime = (iso: string): string => new Date(iso).toISOString().slice(0, 19).replace("T", " ");

const mapIncident = (row: SnRow): Incident => ({
  number: display(row, "number") ?? "",
  sysId: row.sys_id?.value ?? "",
  priority: row.priority?.value ?? "",
  state: display(row, "state") ?? "",
  shortDescription: display(row, "short_description") ?? "",
  description: display(row, "description"),
  assignedTo: display(row, "assigned_to"),
  assignmentGroup: display(row, "assignment_group"),
  businessService: display(row, "business_service"),
  cmdbCi: display(row, "cmdb_ci"),
  openedAt: isoDate(row, "opened_at") ?? "",
  updatedAt: isoDate(row, "sys_updated_on") ?? "",
  resolvedAt: isoDate(row, "resolved_at"),
  slaDue: isoDate(row, "sla_due"),
  workNotes: journal(row, "work_notes"),
  comments: journal(row, "comments")
});

const mapChange = (row: SnRow): ChangeRecord => ({
  number: display(row, "number") ?? "",
  sysId: row.sys_id?.value ?? "",
  state: display(row, "state") ?? "",
  type: display(row, "type"),
  risk: display(row, "risk"),
  impact: display(row, "impact"),
  shortDescription: display(row, "short_description") ?? "",
  description: display(row, "description"),
  assignedTo: display(row, "assigned_to"),
  assignmentGroup: display(row, "assignment_group"),
  businessService: display(row, "business_service"),
  cmdbCi: display(row, "cmdb_ci"),
  plannedStartDate: isoDate(row, "start_date"),
  plannedEndDate: isoDate(row, "end_date"),
  actualStartDate: isoDate(row, "work_start"),
  actualEndDate: isoDate(row, "work_end"),
  implementationPlan: display(row, "implementation_plan"),
  backoutPlan: display(row, "backout_plan"),
  testPlan: display(row, "test_plan"),
  closeCode: display(row, "close_code"),
  closeNotes: display(row, "close_notes")
});

export interface IncidentListFilters {
  stateNot?: string;
  priority?: string;
  assignmentGroup?: string;
  assignedTo?: string; // "" means unassigned-only
  shortDescriptionContains?: string;
  limit?: number;
}

export interface ChangeListFilters {
  stateNot?: string; // raw change_request state code (no name→code map for changes; pass numeric code)
  assignmentGroup?: string;
  configurationItem?: string;
  startedAfter?: string; // ISO 8601
  startedBefore?: string; // ISO 8601
  limit?: number;
}

export class ServiceNowClient {
  private readonly dispatcher?: FetchDispatcher;

  constructor(private readonly cfg: ServiceNowConfig) {
    this.dispatcher = proxyDispatcher(cfg.proxyUrl);
  }

  private async request(table: string, query: string, limit: number, fields: string): Promise<SnRow[]> {
    const url = new URL(`/api/now/table/${table}`, this.cfg.baseUrl);
    url.searchParams.set("sysparm_query", query);
    url.searchParams.set("sysparm_limit", String(limit));
    url.searchParams.set("sysparm_fields", fields);
    url.searchParams.set("sysparm_display_value", "all");
    url.searchParams.set("sysparm_exclude_reference_link", "true");

    const res = await fetch(url.toString(), {
      headers: {
        Accept: "application/json",
        Authorization: "Basic " + Buffer.from(`${this.cfg.username}:${this.cfg.password}`).toString("base64")
      },
      dispatcher: this.dispatcher
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      throw new Error(`ServiceNow GET ${table} failed: ${res.status} ${body}`);
    }
    const json = (await res.json()) as { result?: SnRow[] };
    return json.result ?? [];
  }

  async listIncidentsWithFilters(f: IncidentListFilters): Promise<Incident[]> {
    const parts: string[] = [];
    if (f.stateNot) parts.push(`state!=${snSafe(stateCode(f.stateNot))}`);
    if (f.priority) parts.push(`priority=${f.priority}`);
    if (f.assignmentGroup) parts.push(`assignment_group.name=${snSafe(f.assignmentGroup)}`);
    if (f.assignedTo === "") parts.push("assigned_toISEMPTY");
    else if (f.assignedTo) parts.push(`assigned_to.name=${snSafe(f.assignedTo)}`);
    if (f.shortDescriptionContains) parts.push(`short_descriptionLIKE${snSafe(f.shortDescriptionContains)}`);
    parts.push("ORDERBYDESCsys_updated_on");
    const rows = await this.request("incident", parts.join("^"), Math.min(f.limit ?? 50, 200), INCIDENT_FIELDS);
    return rows.map(mapIncident);
  }

  async listIncidents(f: { onlyOpen?: boolean; assignmentGroup?: string }): Promise<Incident[]> {
    const parts: string[] = [];
    if (f.onlyOpen) parts.push(OPEN_INCIDENT_QUERY);
    if (f.assignmentGroup) parts.push(`assignment_group.name=${snSafe(f.assignmentGroup)}`);
    parts.push("ORDERBYDESCsys_updated_on");
    const rows = await this.request("incident", parts.join("^"), 200, INCIDENT_FIELDS);
    return rows.map(mapIncident);
  }

  async getIncidentByNumber(number: string): Promise<Incident | null> {
    const rows = await this.request("incident", `number=${number}`, 1, INCIDENT_FIELDS);
    return rows.length ? mapIncident(rows[0]) : null;
  }

  async listChangesWithFilters(f: ChangeListFilters): Promise<ChangeRecord[]> {
    const parts: string[] = [];
    if (f.stateNot) parts.push(`state!=${snSafe(f.stateNot)}`);
    if (f.assignmentGroup) parts.push(`assignment_group.name=${snSafe(f.assignmentGroup)}`);
    if (f.configurationItem) parts.push(`cmdb_ci.name=${snSafe(f.configurationItem)}`);
    if (f.startedAfter) parts.push(`start_date>=${toSnDateTime(f.startedAfter)}`);
    if (f.startedBefore) parts.push(`start_date<=${toSnDateTime(f.startedBefore)}`);
    parts.push("ORDERBYDESCstart_date");
    const rows = await this.request("change_request", parts.join("^"), Math.min(f.limit ?? 50, 200), CHANGE_FIELDS);
    return rows.map(mapChange);
  }

  async getChangeByNumber(number: string): Promise<ChangeRecord | null> {
    const rows = await this.request("change_request", `number=${number}`, 1, CHANGE_FIELDS);
    return rows.length ? mapChange(rows[0]) : null;
  }
}
