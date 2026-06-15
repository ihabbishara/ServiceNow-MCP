# Standalone SRE Ops MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the MCP server in `MCP/` build and run standalone by reimplementing the missing SREOps service layer (types, config, ServiceNow + ADO clients, domain services) behind the exact interfaces the existing tools/resources/prompts already consume.

**Architecture:** Existing consumer code (`tools/`, `resources/`, `prompts/`, `server.ts`, `index.ts`) stays untouched except two import lines. New code: `types.ts`, `config.ts` (zod-validated env), `clients/servicenow.ts` (Table API via fetch, basic auth), `clients/ado.ts` (WIQL + work-item create via fetch, PAT), five small services with pure logic, and a rewritten `runtime.ts` wiring it together. Spec: `docs/superpowers/specs/2026-06-11-standalone-mcp-design.md`.

**Tech Stack:** TypeScript 5 (ESM, NodeNext), zod, native `fetch` (Node 18+), vitest, `@modelcontextprotocol/sdk`.

**Working directory for all commands:** `/path/to/ServiceNow-MCP/MCP`

**Conventions:** Tests live in `MCP/tests/`, outside `tsconfig.json`'s `include: ["src/**/*"]`, so `tsc` never compiles them; vitest transpiles on the fly. All source imports use `.js` extensions (NodeNext ESM requirement). Commit after every task from the repo root.

---

### Task 1: Domain types

**Files:**
- Create: `src/types.ts`

No behavior — types only, so no test. Verified by compiler in later tasks.

- [ ] **Step 1: Write `src/types.ts`**

```typescript
export interface Incident {
  number: string;
  sysId: string;
  priority: string; // "1".."4" (raw value, not display label)
  state: string; // display value, e.g. "In Progress"
  shortDescription: string;
  description?: string;
  assignedTo?: string;
  assignmentGroup?: string;
  businessService?: string;
  cmdbCi?: string;
  openedAt: string; // ISO 8601 UTC
  updatedAt: string;
  resolvedAt?: string;
  slaDue?: string;
  workNotes?: string[];
  comments?: string[];
}

export interface ChangeRecord {
  number: string;
  sysId: string;
  state: string;
  type?: string;
  risk?: string;
  impact?: string;
  shortDescription: string;
  description?: string;
  assignedTo?: string;
  assignmentGroup?: string;
  businessService?: string;
  cmdbCi?: string;
  plannedStartDate?: string;
  plannedEndDate?: string;
  actualStartDate?: string;
  actualEndDate?: string;
  implementationPlan?: string;
  backoutPlan?: string;
  testPlan?: string;
  closeCode?: string;
  closeNotes?: string;
}

export interface RelatedChange {
  changeNumber: string;
  shortDescription: string;
  state: string;
  risk?: string;
  plannedStart?: string;
  actualStart?: string;
  correlationReason: string;
  confidenceScore: number; // 0..1
}

export type SlaRiskLevel = "Critical" | "High" | "Medium" | "Low";

export interface SlaRiskItem {
  incidentNumber: string;
  priority: string;
  assignmentGroup?: string;
  slaDue: string;
  remainingMinutes: number; // negative when already breached
  riskLevel: SlaRiskLevel;
  suggestedAction: string;
}

export interface StaleTicketItem {
  incidentNumber: string;
  priority: string;
  assignmentGroup?: string;
  lastUpdated: string;
  staleByMinutes: number; // minutes past the threshold
  thresholdMinutes: number;
}

export interface WorkItem {
  id: number;
  title: string;
  state: string;
  assignedTo?: string;
  areaPath?: string;
  tags?: string[];
}

export interface DailyOpsReport {
  generatedAt: string;
  generatedForDate: string; // YYYY-MM-DD
  executiveSummary: string;
  openIncidentsByPriority: Record<string, number>;
  slaRisks: SlaRiskItem[];
  staleIncidents: StaleTicketItem[];
  majorIncidents: Incident[];
  failedOrHighRiskChanges: ChangeRecord[];
  upcomingChanges: ChangeRecord[];
  recommendedActions: string[];
}
```

Field provenance (do not rename): `Incident` fields match `tools/incidents.ts` and `resources/incidents.ts`; `ChangeRecord` extras (`type`, `impact`, `implementationPlan`, `backoutPlan`, `testPlan`, `closeCode`, `closeNotes`, `assignedTo`, `cmdbCi`) match `resources/changes.ts`; `RelatedChange`, `SlaRiskItem`, `StaleTicketItem` match `tools/analysis.ts` + `tools/changes.ts`; `DailyOpsReport` matches `tools/analysis.ts` `generate_ops_summary`.

- [ ] **Step 2: Commit**

```bash
cd /path/to/ServiceNow-MCP
git add MCP/src/types.ts
git commit -m "feat: add standalone domain types for MCP server"
```

---

### Task 2: Config loader

**Files:**
- Create: `src/config.ts`
- Test: `tests/config.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/config.test.ts
import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

const validEnv = {
  SERVICENOW_BASE_URL: "https://example.service-now.com",
  SERVICENOW_USERNAME: "api.user",
  SERVICENOW_PASSWORD: "secret"
};

describe("loadConfig", () => {
  it("loads minimal config with defaults", () => {
    const cfg = loadConfig(validEnv);
    expect(cfg.serviceNow.enabled).toBe(true);
    expect(cfg.serviceNow.baseUrl).toBe("https://example.service-now.com");
    expect(cfg.azureDevOps.enabled).toBe(false);
    expect(cfg.azureDevOps.disabledMode).toBe("noop");
    expect(cfg.features.createAdoBug).toBe(true);
    expect(cfg.thresholds.staleByPriorityMinutes).toEqual({ "1": 30, "2": 120, "3": 1440, "4": 4320 });
    expect(cfg.thresholds.relatedChangeWindow).toEqual({ beforeHours: 24, afterHours: 4 });
  });

  it("strips trailing slash from base URL", () => {
    const cfg = loadConfig({ ...validEnv, SERVICENOW_BASE_URL: "https://example.service-now.com/" });
    expect(cfg.serviceNow.baseUrl).toBe("https://example.service-now.com");
  });

  it("throws naming the missing required vars", () => {
    expect(() => loadConfig({})).toThrow(/SERVICENOW_BASE_URL/);
    expect(() => loadConfig({})).toThrow(/SERVICENOW_USERNAME/);
  });

  it("requires ADO vars when ADO_ENABLED=true", () => {
    expect(() => loadConfig({ ...validEnv, ADO_ENABLED: "true" })).toThrow(/ADO_ORG_URL, ADO_PROJECT, and ADO_PAT/);
  });

  it("accepts full ADO config, defaults paths to project name", () => {
    const cfg = loadConfig({
      ...validEnv,
      ADO_ENABLED: "true",
      ADO_ORG_URL: "https://dev.azure.com/acme",
      ADO_PROJECT: "Platform",
      ADO_PAT: "pat123"
    });
    expect(cfg.azureDevOps.enabled).toBe(true);
    expect(cfg.azureDevOps.defaultAreaPath).toBe("Platform");
    expect(cfg.azureDevOps.defaultIterationPath).toBe("Platform");
  });

  it("applies threshold overrides from env", () => {
    const cfg = loadConfig({ ...validEnv, STALE_P1_MIN: "15", CORRELATION_HOURS_BEFORE: "48" });
    expect(cfg.thresholds.staleByPriorityMinutes["1"]).toBe(15);
    expect(cfg.thresholds.relatedChangeWindow.beforeHours).toBe(48);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — `Cannot find module '../src/config.js'`

- [ ] **Step 3: Write `src/config.ts`**

```typescript
import { z } from "zod";

const boolString = z.enum(["true", "false"]).default("false").transform((v) => v === "true");
const trueBoolString = z.enum(["true", "false"]).default("true").transform((v) => v === "true");

const envSchema = z.object({
  SERVICENOW_BASE_URL: z.string({ required_error: "SERVICENOW_BASE_URL is required" }).url(),
  SERVICENOW_USERNAME: z.string({ required_error: "SERVICENOW_USERNAME is required" }).min(1),
  SERVICENOW_PASSWORD: z.string({ required_error: "SERVICENOW_PASSWORD is required" }).min(1),
  ADO_ENABLED: boolString,
  ADO_ORG_URL: z.string().url().optional(),
  ADO_PROJECT: z.string().min(1).optional(),
  ADO_PAT: z.string().min(1).optional(),
  ADO_AREA_PATH: z.string().optional(),
  ADO_ITERATION_PATH: z.string().optional(),
  ADO_ASSIGNED_TEAM: z.string().optional(),
  ADO_CREATE_BUG_ENABLED: trueBoolString,
  STALE_P1_MIN: z.coerce.number().int().positive().default(30),
  STALE_P2_MIN: z.coerce.number().int().positive().default(120),
  STALE_P3_MIN: z.coerce.number().int().positive().default(1440),
  STALE_P4_MIN: z.coerce.number().int().positive().default(4320),
  CORRELATION_HOURS_BEFORE: z.coerce.number().positive().default(24),
  CORRELATION_HOURS_AFTER: z.coerce.number().positive().default(4)
});

export interface ServiceNowConfig {
  enabled: boolean; // always true; kept because index.ts logs it
  baseUrl: string;
  username: string;
  password: string;
}

export interface AdoConfig {
  enabled: boolean;
  disabledMode: "noop"; // kept because tools/ado.ts checks it
  orgUrl?: string;
  project?: string;
  pat?: string;
  defaultAreaPath?: string;
  defaultIterationPath?: string;
  defaultAssignedTeam?: string;
}

export interface AppConfig {
  serviceNow: ServiceNowConfig;
  azureDevOps: AdoConfig;
  features: { createAdoBug: boolean };
  thresholds: {
    staleByPriorityMinutes: Record<string, number>;
    relatedChangeWindow: { beforeHours: number; afterHours: number };
  };
}

export const loadConfig = (env: Record<string, string | undefined> = process.env): AppConfig => {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n  ");
    throw new Error(`Invalid configuration:\n  ${issues}`);
  }
  const e = parsed.data;
  if (e.ADO_ENABLED && (!e.ADO_ORG_URL || !e.ADO_PROJECT || !e.ADO_PAT)) {
    throw new Error("ADO_ENABLED=true requires ADO_ORG_URL, ADO_PROJECT, and ADO_PAT");
  }
  return {
    serviceNow: {
      enabled: true,
      baseUrl: e.SERVICENOW_BASE_URL.replace(/\/+$/, ""),
      username: e.SERVICENOW_USERNAME,
      password: e.SERVICENOW_PASSWORD
    },
    azureDevOps: {
      enabled: e.ADO_ENABLED,
      disabledMode: "noop",
      orgUrl: e.ADO_ORG_URL?.replace(/\/+$/, ""),
      project: e.ADO_PROJECT,
      pat: e.ADO_PAT,
      defaultAreaPath: e.ADO_AREA_PATH ?? e.ADO_PROJECT,
      defaultIterationPath: e.ADO_ITERATION_PATH ?? e.ADO_PROJECT,
      defaultAssignedTeam: e.ADO_ASSIGNED_TEAM
    },
    features: { createAdoBug: e.ADO_CREATE_BUG_ENABLED },
    thresholds: {
      staleByPriorityMinutes: { "1": e.STALE_P1_MIN, "2": e.STALE_P2_MIN, "3": e.STALE_P3_MIN, "4": e.STALE_P4_MIN },
      relatedChangeWindow: { beforeHours: e.CORRELATION_HOURS_BEFORE, afterHours: e.CORRELATION_HOURS_AFTER }
    }
  };
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
cd /path/to/ServiceNow-MCP
git add MCP/src/config.ts MCP/tests/config.test.ts
git commit -m "feat: add zod-validated env config loader"
```

---

### Task 3: ServiceNow client

**Files:**
- Create: `src/clients/servicenow.ts`
- Test: `tests/clients/servicenow.test.ts`

Background for the implementer: ServiceNow Table API is `GET {base}/api/now/table/{table}` with `sysparm_query` (an "encoded query": conditions joined by `^`, e.g. `state!=7^priority=1`). `sysparm_display_value=all` makes every field come back as `{ value, display_value }` — we read machine values (`value`) for dates/priority/sys_id and human labels (`display_value`) for references like assignment group. `value` timestamps are UTC `"YYYY-MM-DD HH:MM:SS"`.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/clients/servicenow.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ServiceNowClient } from "../../src/clients/servicenow.js";

const cfg = { enabled: true, baseUrl: "https://example.service-now.com", username: "u", password: "p" };

const snField = (value: string, display = value) => ({ value, display_value: display });

const incidentRow = {
  number: snField("INC0001"),
  sys_id: snField("abc123"),
  priority: snField("1", "1 - Critical"),
  state: snField("2", "In Progress"),
  short_description: snField("DB down"),
  description: snField("Primary DB unreachable"),
  assigned_to: snField("u1", "Jane Doe"),
  assignment_group: snField("g1", "Platform SRE"),
  business_service: snField("s1", "Payments"),
  cmdb_ci: snField("ci1", "db-prod-01"),
  opened_at: snField("2026-06-10 08:00:00"),
  sys_updated_on: snField("2026-06-11 09:30:00"),
  sla_due: snField("2026-06-11 12:00:00"),
  work_notes: snField("", "Investigating failover"),
  comments: snField("", "")
};

const changeRow = {
  number: snField("CHG0001"),
  sys_id: snField("chg-sys-1"),
  state: snField("3", "Implement"),
  type: snField("normal", "Normal"),
  risk: snField("2", "High"),
  impact: snField("2", "Medium"),
  short_description: snField("DB failover patch"),
  assignment_group: snField("g1", "Platform SRE"),
  cmdb_ci: snField("ci1", "db-prod-01"),
  business_service: snField("s1", "Payments"),
  start_date: snField("2026-06-10 06:00:00"),
  end_date: snField("2026-06-10 07:00:00"),
  work_start: snField("2026-06-10 06:05:00"),
  work_end: snField("")
};

const okResponse = (rows: unknown[]) =>
  ({ ok: true, status: 200, json: async () => ({ result: rows }), text: async () => "" }) as unknown as Response;

describe("ServiceNowClient", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("builds encoded query, caps limit at 200, maps incident fields", async () => {
    fetchMock.mockResolvedValue(okResponse([incidentRow]));
    const client = new ServiceNowClient(cfg);
    const result = await client.listIncidentsWithFilters({
      stateNot: "Closed",
      priority: "1",
      assignmentGroup: "Platform SRE",
      shortDescriptionContains: "DB",
      limit: 500
    });

    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.pathname).toBe("/api/now/table/incident");
    expect(url.searchParams.get("sysparm_query")).toBe(
      "state!=7^priority=1^assignment_group.name=Platform SRE^short_descriptionLIKEDB^ORDERBYDESCsys_updated_on"
    );
    expect(url.searchParams.get("sysparm_limit")).toBe("200");
    expect(url.searchParams.get("sysparm_display_value")).toBe("all");

    expect(result[0]).toMatchObject({
      number: "INC0001",
      sysId: "abc123",
      priority: "1",
      state: "In Progress",
      shortDescription: "DB down",
      assignedTo: "Jane Doe",
      assignmentGroup: "Platform SRE",
      businessService: "Payments",
      cmdbCi: "db-prod-01",
      openedAt: "2026-06-10T08:00:00Z",
      updatedAt: "2026-06-11T09:30:00Z",
      slaDue: "2026-06-11T12:00:00Z",
      workNotes: ["Investigating failover"]
    });
    expect(result[0].comments).toBeUndefined(); // empty journal → undefined, not [""]
  });

  it("sends basic auth header", async () => {
    fetchMock.mockResolvedValue(okResponse([]));
    await new ServiceNowClient(cfg).listIncidents({ onlyOpen: true });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Basic " + Buffer.from("u:p").toString("base64")
    );
  });

  it("uses ISEMPTY when assignedTo is empty string (unassigned filter)", async () => {
    fetchMock.mockResolvedValue(okResponse([]));
    await new ServiceNowClient(cfg).listIncidentsWithFilters({ assignedTo: "" });
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.get("sysparm_query")).toContain("assigned_toISEMPTY");
  });

  it("listIncidents onlyOpen excludes resolved/closed/canceled states", async () => {
    fetchMock.mockResolvedValue(okResponse([]));
    await new ServiceNowClient(cfg).listIncidents({ onlyOpen: true, assignmentGroup: "Platform SRE" });
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.searchParams.get("sysparm_query")).toBe(
      "stateNOT IN6,7,8^assignment_group.name=Platform SRE^ORDERBYDESCsys_updated_on"
    );
  });

  it("getIncidentByNumber returns null when no rows", async () => {
    fetchMock.mockResolvedValue(okResponse([]));
    expect(await new ServiceNowClient(cfg).getIncidentByNumber("INC9999")).toBeNull();
  });

  it("maps change fields including planned/actual dates", async () => {
    fetchMock.mockResolvedValue(okResponse([changeRow]));
    const result = await new ServiceNowClient(cfg).listChangesWithFilters({ startedAfter: "2026-06-09T00:00:00Z" });
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.pathname).toBe("/api/now/table/change_request");
    expect(url.searchParams.get("sysparm_query")).toContain("start_date>=2026-06-09 00:00:00");
    expect(result[0]).toMatchObject({
      number: "CHG0001",
      state: "Implement",
      type: "Normal",
      risk: "High",
      cmdbCi: "db-prod-01",
      plannedStartDate: "2026-06-10T06:00:00Z",
      actualStartDate: "2026-06-10T06:05:00Z"
    });
    expect(result[0].actualEndDate).toBeUndefined();
  });

  it("throws with status and body snippet on non-2xx", async () => {
    fetchMock.mockResolvedValue({
      ok: false, status: 401, json: async () => ({}), text: async () => "User Not Authenticated"
    } as unknown as Response);
    await expect(new ServiceNowClient(cfg).getIncidentByNumber("INC1")).rejects.toThrow(/401.*User Not Authenticated/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/clients/servicenow.test.ts`
Expected: FAIL — `Cannot find module '../../src/clients/servicenow.js'`

- [ ] **Step 3: Write `src/clients/servicenow.ts`**

```typescript
import { Incident, ChangeRecord } from "../types.js";
import { ServiceNowConfig } from "../config.js";

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

const display = (row: SnRow, key: string): string | undefined => row[key]?.display_value || undefined;

// SN "value" timestamps are UTC "YYYY-MM-DD HH:MM:SS"
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
  stateNot?: string;
  assignmentGroup?: string;
  configurationItem?: string;
  startedAfter?: string; // ISO 8601
  limit?: number;
}

export class ServiceNowClient {
  constructor(private readonly cfg: ServiceNowConfig) {}

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
      }
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
    if (f.stateNot) parts.push(`state!=${stateCode(f.stateNot)}`);
    if (f.priority) parts.push(`priority=${f.priority}`);
    if (f.assignmentGroup) parts.push(`assignment_group.name=${f.assignmentGroup}`);
    if (f.assignedTo === "") parts.push("assigned_toISEMPTY");
    else if (f.assignedTo) parts.push(`assigned_to.name=${f.assignedTo}`);
    if (f.shortDescriptionContains) parts.push(`short_descriptionLIKE${f.shortDescriptionContains}`);
    parts.push("ORDERBYDESCsys_updated_on");
    const rows = await this.request("incident", parts.join("^"), Math.min(f.limit ?? 50, 200), INCIDENT_FIELDS);
    return rows.map(mapIncident);
  }

  async listIncidents(f: { onlyOpen?: boolean; assignmentGroup?: string }): Promise<Incident[]> {
    const parts: string[] = [];
    if (f.onlyOpen) parts.push(OPEN_INCIDENT_QUERY);
    if (f.assignmentGroup) parts.push(`assignment_group.name=${f.assignmentGroup}`);
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
    if (f.stateNot) parts.push(`state!=${f.stateNot}`);
    if (f.assignmentGroup) parts.push(`assignment_group.name=${f.assignmentGroup}`);
    if (f.configurationItem) parts.push(`cmdb_ci.name=${f.configurationItem}`);
    if (f.startedAfter) parts.push(`start_date>=${toSnDateTime(f.startedAfter)}`);
    parts.push("ORDERBYDESCstart_date");
    const rows = await this.request("change_request", parts.join("^"), Math.min(f.limit ?? 50, 200), CHANGE_FIELDS);
    return rows.map(mapChange);
  }

  async getChangeByNumber(number: string): Promise<ChangeRecord | null> {
    const rows = await this.request("change_request", `number=${number}`, 1, CHANGE_FIELDS);
    return rows.length ? mapChange(rows[0]) : null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/clients/servicenow.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
cd /path/to/ServiceNow-MCP
git add MCP/src/clients/servicenow.ts MCP/tests/clients/servicenow.test.ts
git commit -m "feat: add ServiceNow Table API client with basic auth"
```

---

### Task 4: Azure DevOps client

**Files:**
- Create: `src/clients/ado.ts`
- Test: `tests/clients/ado.test.ts`

Background: ADO work-item search is two calls — `POST {org}/{project}/_apis/wit/wiql?api-version=7.1` with a WIQL query returns IDs; `GET .../_apis/wit/workitems?ids=...&fields=...` returns details. Create is `POST .../_apis/wit/workitems/$Bug` with content type `application/json-patch+json`. PAT auth = `Basic base64(":" + pat)`. Single quotes in WIQL strings are escaped by doubling.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/clients/ado.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AzureDevOpsClient } from "../../src/clients/ado.js";

const cfg = {
  enabled: true,
  disabledMode: "noop" as const,
  orgUrl: "https://dev.azure.com/acme",
  project: "Platform",
  pat: "pat123",
  defaultAreaPath: "Platform",
  defaultIterationPath: "Platform",
  defaultAssignedTeam: undefined
};

const jsonResponse = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body, text: async () => "" }) as unknown as Response;

describe("AzureDevOpsClient", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("searchWorkItems posts WIQL then fetches details", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ workItems: [{ id: 42 }, { id: 43 }] }))
      .mockResolvedValueOnce(jsonResponse({
        value: [
          {
            id: 42,
            fields: {
              "System.Title": "[INC0001] DB down",
              "System.State": "Active",
              "System.AssignedTo": { displayName: "Jane Doe" },
              "System.AreaPath": "Platform\\SRE",
              "System.Tags": "ServiceNow; Incident"
            }
          },
          { id: 43, fields: { "System.Title": "Other", "System.State": "New" } }
        ]
      }));

    const client = new AzureDevOpsClient(cfg);
    const items = await client.searchWorkItems({ text: "INC0001", workItemType: "Bug", state: "Active" });

    const [wiqlUrl, wiqlInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(wiqlUrl).toBe("https://dev.azure.com/acme/Platform/_apis/wit/wiql?api-version=7.1&$top=50");
    expect(JSON.parse(wiqlInit.body as string).query).toBe(
      "SELECT [System.Id] FROM WorkItems WHERE [System.Title] CONTAINS 'INC0001' AND [System.WorkItemType] = 'Bug' AND [System.State] = 'Active' ORDER BY [System.ChangedDate] DESC"
    );
    expect((wiqlInit.headers as Record<string, string>).Authorization).toBe(
      "Basic " + Buffer.from(":pat123").toString("base64")
    );

    const detailsUrl = fetchMock.mock.calls[1][0] as string;
    expect(detailsUrl).toContain("/_apis/wit/workitems?ids=42,43");

    expect(items[0]).toEqual({
      id: 42,
      title: "[INC0001] DB down",
      state: "Active",
      assignedTo: "Jane Doe",
      areaPath: "Platform\\SRE",
      tags: ["ServiceNow", "Incident"]
    });
    expect(items[1].assignedTo).toBeUndefined();
  });

  it("escapes single quotes in WIQL", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ workItems: [] }));
    await new AzureDevOpsClient(cfg).searchWorkItems({ text: "user's incident" });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.query).toContain("CONTAINS 'user''s incident'");
  });

  it("returns [] without fetching when WIQL matches nothing", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ workItems: [] }));
    const items = await new AzureDevOpsClient(cfg).searchWorkItems({ text: "nope" });
    expect(items).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns [] when integration is disabled, without any fetch", async () => {
    const items = await new AzureDevOpsClient({ ...cfg, enabled: false }).searchWorkItems({ text: "x" });
    expect(items).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("createBug posts json-patch document", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 99, fields: { "System.Title": "[INC0001] DB down" } }));
    const created = await new AzureDevOpsClient(cfg).createBug({
      title: "[INC0001] DB down",
      description: "line1\nline2",
      areaPath: "Platform\\SRE",
      iterationPath: "Platform\\Sprint 1",
      tags: ["ServiceNow", "Incident"],
      incidentNumber: "INC0001"
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://dev.azure.com/acme/Platform/_apis/wit/workitems/$Bug?api-version=7.1");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json-patch+json");
    const ops = JSON.parse(init.body as string) as Array<{ op: string; path: string; value: string }>;
    expect(ops).toContainEqual({ op: "add", path: "/fields/System.Title", value: "[INC0001] DB down" });
    expect(ops).toContainEqual({ op: "add", path: "/fields/Microsoft.VSTS.TCM.ReproSteps", value: "line1<br>line2" });
    expect(ops).toContainEqual({ op: "add", path: "/fields/System.AreaPath", value: "Platform\\SRE" });
    expect(ops).toContainEqual({ op: "add", path: "/fields/System.Tags", value: "ServiceNow; Incident" });
    expect(created).toEqual({ id: 99, title: "[INC0001] DB down" });
  });

  it("createBug throws when integration is disabled", async () => {
    await expect(
      new AzureDevOpsClient({ ...cfg, enabled: false }).createBug({ title: "t", description: "d", incidentNumber: "INC1" })
    ).rejects.toThrow(/disabled/);
  });

  it("throws with status and body snippet on non-2xx", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false, status: 403, json: async () => ({}), text: async () => "TF401027 denied"
    } as unknown as Response);
    await expect(new AzureDevOpsClient(cfg).searchWorkItems({ text: "x" })).rejects.toThrow(/403.*TF401027/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/clients/ado.test.ts`
Expected: FAIL — `Cannot find module '../../src/clients/ado.js'`

- [ ] **Step 3: Write `src/clients/ado.ts`**

```typescript
import { WorkItem } from "../types.js";
import { AdoConfig } from "../config.js";

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

export interface WorkItemSearchFilters {
  text: string;
  workItemType?: string;
  state?: string;
}

export interface CreateBugPayload {
  title: string;
  description: string;
  areaPath?: string;
  iterationPath?: string;
  tags?: string[];
  assignedTeam?: string;
  incidentNumber: string;
}

export class AzureDevOpsClient {
  constructor(private readonly cfg: AdoConfig) {}

  private get authHeader(): string {
    return "Basic " + Buffer.from(`:${this.cfg.pat ?? ""}`).toString("base64");
  }

  private apiUrl(path: string): string {
    return `${this.cfg.orgUrl}/${this.cfg.project}/_apis/${path}`;
  }

  private async requestJson<T>(url: string, init: RequestInit): Promise<T> {
    const res = await fetch(url, init);
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      throw new Error(`Azure DevOps request failed: ${res.status} ${body}`);
    }
    return (await res.json()) as T;
  }

  async searchWorkItems(f: WorkItemSearchFilters): Promise<WorkItem[]> {
    if (!this.cfg.enabled) return [];

    const conditions = [`[System.Title] CONTAINS '${escapeWiql(f.text)}'`];
    if (f.workItemType) conditions.push(`[System.WorkItemType] = '${escapeWiql(f.workItemType)}'`);
    if (f.state) conditions.push(`[System.State] = '${escapeWiql(f.state)}'`);
    const query =
      `SELECT [System.Id] FROM WorkItems WHERE ${conditions.join(" AND ")} ORDER BY [System.ChangedDate] DESC`;

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

  async createBug(p: CreateBugPayload): Promise<{ id: number; title: string }> {
    if (!this.cfg.enabled) throw new Error("ADO integration is disabled");

    const ops: Array<{ op: "add"; path: string; value: string }> = [
      { op: "add", path: "/fields/System.Title", value: p.title },
      { op: "add", path: "/fields/Microsoft.VSTS.TCM.ReproSteps", value: p.description.replace(/\n/g, "<br>") }
    ];
    const areaPath = p.areaPath ?? this.cfg.defaultAreaPath;
    const iterationPath = p.iterationPath ?? this.cfg.defaultIterationPath;
    if (areaPath) ops.push({ op: "add", path: "/fields/System.AreaPath", value: areaPath });
    if (iterationPath) ops.push({ op: "add", path: "/fields/System.IterationPath", value: iterationPath });
    if (p.tags?.length) ops.push({ op: "add", path: "/fields/System.Tags", value: p.tags.join("; ") });

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/clients/ado.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
cd /path/to/ServiceNow-MCP
git add MCP/src/clients/ado.ts MCP/tests/clients/ado.test.ts
git commit -m "feat: add Azure DevOps client (WIQL search, bug creation)"
```

---

### Task 5: SLA risk service

**Files:**
- Create: `src/services/slaRisk.ts`
- Test: `tests/services/slaRisk.test.ts`

Rule (from `find_sla_risks` tool description, which is user-facing and must stay truthful): remaining% of the `openedAt → slaDue` window — Critical < 10% (or breached), High < 25%, Medium < 50%, else excluded.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/services/slaRisk.test.ts
import { describe, it, expect } from "vitest";
import { SlaRiskService } from "../../src/services/slaRisk.js";
import { Incident } from "../../src/types.js";

// 100-minute SLA window: opened 10:00, due 11:40
const baseIncident = (overrides: Partial<Incident>): Incident => ({
  number: "INC0001",
  sysId: "x",
  priority: "1",
  state: "In Progress",
  shortDescription: "test",
  openedAt: "2026-06-11T10:00:00Z",
  updatedAt: "2026-06-11T10:00:00Z",
  slaDue: "2026-06-11T11:40:00Z",
  ...overrides
});

const svc = new SlaRiskService();

describe("SlaRiskService", () => {
  it("classifies by remaining percentage of the SLA window", () => {
    // now = 11:35 → 5 of 100 min left = 5% → Critical
    expect(svc.assess([baseIncident({})], new Date("2026-06-11T11:35:00Z"))[0].riskLevel).toBe("Critical");
    // now = 11:20 → 20% → High
    expect(svc.assess([baseIncident({})], new Date("2026-06-11T11:20:00Z"))[0].riskLevel).toBe("High");
    // now = 11:00 → 40% → Medium
    expect(svc.assess([baseIncident({})], new Date("2026-06-11T11:00:00Z"))[0].riskLevel).toBe("Medium");
    // now = 10:30 → 70% → not at risk
    expect(svc.assess([baseIncident({})], new Date("2026-06-11T10:30:00Z"))).toHaveLength(0);
  });

  it("treats breached SLA as Critical with negative remaining minutes", () => {
    const result = svc.assess([baseIncident({})], new Date("2026-06-11T12:00:00Z"));
    expect(result[0].riskLevel).toBe("Critical");
    expect(result[0].remainingMinutes).toBe(-20);
  });

  it("skips incidents without slaDue or with invalid window", () => {
    expect(svc.assess([baseIncident({ slaDue: undefined })], new Date())).toHaveLength(0);
    expect(svc.assess([baseIncident({ slaDue: "2026-06-11T09:00:00Z" })], new Date())).toHaveLength(0); // due before opened
  });

  it("sorts most urgent first and fills suggestedAction", () => {
    const urgent = baseIncident({ number: "INC-URGENT" });
    const later = baseIncident({ number: "INC-LATER", slaDue: "2026-06-11T12:30:00Z", openedAt: "2026-06-11T11:30:00Z" });
    const result = svc.assess([later, urgent], new Date("2026-06-11T11:35:00Z"));
    expect(result[0].incidentNumber).toBe("INC-URGENT");
    expect(result[0].suggestedAction).toMatch(/escalate/i);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/services/slaRisk.test.ts`
Expected: FAIL — `Cannot find module '../../src/services/slaRisk.js'`

- [ ] **Step 3: Write `src/services/slaRisk.ts`**

```typescript
import { Incident, SlaRiskItem, SlaRiskLevel } from "../types.js";

const ACTIONS: Record<SlaRiskLevel, string> = {
  Critical: "Escalate immediately — SLA breach imminent or already breached",
  High: "Prioritize now and post an update on the ticket",
  Medium: "Review today and confirm the owner is actively working it",
  Low: "Monitor"
};

export class SlaRiskService {
  assess(incidents: Incident[], now: Date = new Date()): SlaRiskItem[] {
    const items: SlaRiskItem[] = [];
    for (const inc of incidents) {
      if (!inc.slaDue) continue;
      const due = Date.parse(inc.slaDue);
      const opened = Date.parse(inc.openedAt);
      if (!Number.isFinite(due) || !Number.isFinite(opened) || due <= opened) continue;

      const remainingMs = due - now.getTime();
      const remainingPct = remainingMs / (due - opened);

      let riskLevel: SlaRiskLevel;
      if (remainingPct < 0.1) riskLevel = "Critical";
      else if (remainingPct < 0.25) riskLevel = "High";
      else if (remainingPct < 0.5) riskLevel = "Medium";
      else continue;

      items.push({
        incidentNumber: inc.number,
        priority: inc.priority,
        assignmentGroup: inc.assignmentGroup,
        slaDue: inc.slaDue,
        remainingMinutes: Math.round(remainingMs / 60000),
        riskLevel,
        suggestedAction: ACTIONS[riskLevel]
      });
    }
    return items.sort((a, b) => a.remainingMinutes - b.remainingMinutes);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/services/slaRisk.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
cd /path/to/ServiceNow-MCP
git add MCP/src/services/slaRisk.ts MCP/tests/services/slaRisk.test.ts
git commit -m "feat: add SLA risk assessment service"
```

---

### Task 6: Stale ticket service

**Files:**
- Create: `src/services/staleTickets.ts`
- Test: `tests/services/staleTickets.test.ts`

Rule: stale when `now - updatedAt > threshold[priority]` (defaults P1=30m, P2=2h, P3=24h, P4=72h, injected from config).

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/services/staleTickets.test.ts
import { describe, it, expect } from "vitest";
import { StaleTicketService } from "../../src/services/staleTickets.js";
import { Incident } from "../../src/types.js";

const thresholds = { "1": 30, "2": 120, "3": 1440, "4": 4320 };
const svc = new StaleTicketService(thresholds);
const now = new Date("2026-06-11T12:00:00Z");

const incident = (number: string, priority: string, updatedAt: string): Incident => ({
  number, sysId: "x", priority, state: "In Progress", shortDescription: "t",
  openedAt: "2026-06-11T00:00:00Z", updatedAt
});

describe("StaleTicketService", () => {
  it("flags tickets past their priority threshold with overshoot minutes", () => {
    // P1, threshold 30 min, last update 100 min ago → stale by 70
    const result = svc.findStale([incident("INC1", "1", "2026-06-11T10:20:00Z")], now);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ incidentNumber: "INC1", staleByMinutes: 70, thresholdMinutes: 30 });
  });

  it("does not flag tickets within threshold", () => {
    // P2, threshold 120 min, last update 60 min ago
    expect(svc.findStale([incident("INC2", "2", "2026-06-11T11:00:00Z")], now)).toHaveLength(0);
  });

  it("skips unknown priorities", () => {
    expect(svc.findStale([incident("INC3", "5", "2026-06-01T00:00:00Z")], now)).toHaveLength(0);
  });

  it("sorts most stale first", () => {
    const result = svc.findStale(
      [incident("INC-A", "1", "2026-06-11T11:00:00Z"), incident("INC-B", "1", "2026-06-11T09:00:00Z")],
      now
    );
    expect(result.map((t) => t.incidentNumber)).toEqual(["INC-B", "INC-A"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/services/staleTickets.test.ts`
Expected: FAIL — `Cannot find module '../../src/services/staleTickets.js'`

- [ ] **Step 3: Write `src/services/staleTickets.ts`**

```typescript
import { Incident, StaleTicketItem } from "../types.js";

export class StaleTicketService {
  constructor(private readonly thresholdsByPriority: Record<string, number>) {}

  findStale(incidents: Incident[], now: Date = new Date()): StaleTicketItem[] {
    const items: StaleTicketItem[] = [];
    for (const inc of incidents) {
      const thresholdMinutes = this.thresholdsByPriority[inc.priority];
      if (!thresholdMinutes) continue;
      const updated = Date.parse(inc.updatedAt);
      if (!Number.isFinite(updated)) continue;

      const idleMinutes = Math.floor((now.getTime() - updated) / 60000);
      if (idleMinutes <= thresholdMinutes) continue;

      items.push({
        incidentNumber: inc.number,
        priority: inc.priority,
        assignmentGroup: inc.assignmentGroup,
        lastUpdated: inc.updatedAt,
        staleByMinutes: idleMinutes - thresholdMinutes,
        thresholdMinutes
      });
    }
    return items.sort((a, b) => b.staleByMinutes - a.staleByMinutes);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/services/staleTickets.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
cd /path/to/ServiceNow-MCP
git add MCP/src/services/staleTickets.ts MCP/tests/services/staleTickets.test.ts
git commit -m "feat: add stale ticket detection service"
```

---

### Task 7: Change correlation service

**Files:**
- Create: `src/services/correlation.ts`
- Test: `tests/services/correlation.test.ts`

Rule: candidate changes whose actual-or-planned start falls in `[openedAt - beforeHours, openedAt + afterHours]`. Additive score: same `cmdbCi` +0.5, same `businessService` +0.25, same `assignmentGroup` +0.15, start within ±2h of `openedAt` +0.1. Keep score ≥ 0.25, sort descending.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/services/correlation.test.ts
import { describe, it, expect } from "vitest";
import { ChangeCorrelationService } from "../../src/services/correlation.js";
import { Incident, ChangeRecord } from "../../src/types.js";

const svc = new ChangeCorrelationService({ beforeHours: 24, afterHours: 4 });

const incident: Incident = {
  number: "INC0001", sysId: "x", priority: "1", state: "New", shortDescription: "DB down",
  openedAt: "2026-06-11T10:00:00Z", updatedAt: "2026-06-11T10:00:00Z",
  cmdbCi: "db-prod-01", businessService: "Payments", assignmentGroup: "Platform SRE"
};

const change = (overrides: Partial<ChangeRecord>): ChangeRecord => ({
  number: "CHG0001", sysId: "c", state: "Closed", shortDescription: "patch",
  actualStartDate: "2026-06-11T09:00:00Z",
  ...overrides
});

describe("ChangeCorrelationService", () => {
  it("scores CI + service + group + time proximity matches", () => {
    const result = svc.correlate(incident, [change({
      cmdbCi: "db-prod-01", businessService: "Payments", assignmentGroup: "Platform SRE"
    })]);
    expect(result).toHaveLength(1);
    expect(result[0].confidenceScore).toBe(1); // 0.5+0.25+0.15+0.1
    expect(result[0].correlationReason).toContain("same configuration item");
  });

  it("excludes changes outside the time window", () => {
    expect(svc.correlate(incident, [change({
      cmdbCi: "db-prod-01", actualStartDate: "2026-06-09T09:00:00Z" // 49h before
    })])).toHaveLength(0);
    expect(svc.correlate(incident, [change({
      cmdbCi: "db-prod-01", actualStartDate: "2026-06-11T15:00:00Z" // 5h after
    })])).toHaveLength(0);
  });

  it("excludes weak matches below 0.25", () => {
    // only assignment group (0.15) and outside ±2h proximity → 0.15 < 0.25
    expect(svc.correlate(incident, [change({
      assignmentGroup: "Platform SRE", actualStartDate: "2026-06-11T05:00:00Z"
    })])).toHaveLength(0);
  });

  it("falls back to plannedStartDate when no actual start", () => {
    const result = svc.correlate(incident, [change({
      actualStartDate: undefined, plannedStartDate: "2026-06-11T09:00:00Z", cmdbCi: "db-prod-01"
    })]);
    expect(result).toHaveLength(1);
  });

  it("sorts by confidence descending", () => {
    const result = svc.correlate(incident, [
      change({ number: "CHG-WEAK", businessService: "Payments", actualStartDate: "2026-06-11T01:00:00Z" }),
      change({ number: "CHG-STRONG", cmdbCi: "db-prod-01", businessService: "Payments" })
    ]);
    expect(result.map((r) => r.changeNumber)).toEqual(["CHG-STRONG", "CHG-WEAK"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/services/correlation.test.ts`
Expected: FAIL — `Cannot find module '../../src/services/correlation.js'`

- [ ] **Step 3: Write `src/services/correlation.ts`**

```typescript
import { ChangeRecord, Incident, RelatedChange } from "../types.js";

const HOUR_MS = 3_600_000;

export class ChangeCorrelationService {
  constructor(private readonly window: { beforeHours: number; afterHours: number }) {}

  correlate(incident: Incident, changes: ChangeRecord[]): RelatedChange[] {
    const openedMs = Date.parse(incident.openedAt);
    if (!Number.isFinite(openedMs)) return [];
    const windowStart = openedMs - this.window.beforeHours * HOUR_MS;
    const windowEnd = openedMs + this.window.afterHours * HOUR_MS;

    const related: RelatedChange[] = [];
    for (const change of changes) {
      const startRaw = change.actualStartDate ?? change.plannedStartDate;
      if (!startRaw) continue;
      const startMs = Date.parse(startRaw);
      if (!Number.isFinite(startMs) || startMs < windowStart || startMs > windowEnd) continue;

      let score = 0;
      const reasons: string[] = [];
      if (incident.cmdbCi && change.cmdbCi === incident.cmdbCi) {
        score += 0.5;
        reasons.push("same configuration item");
      }
      if (incident.businessService && change.businessService === incident.businessService) {
        score += 0.25;
        reasons.push("same business service");
      }
      if (incident.assignmentGroup && change.assignmentGroup === incident.assignmentGroup) {
        score += 0.15;
        reasons.push("same assignment group");
      }
      if (Math.abs(startMs - openedMs) <= 2 * HOUR_MS) {
        score += 0.1;
        reasons.push("started within 2h of incident");
      }
      if (score < 0.25) continue;

      related.push({
        changeNumber: change.number,
        shortDescription: change.shortDescription,
        state: change.state,
        risk: change.risk,
        plannedStart: change.plannedStartDate,
        actualStart: change.actualStartDate,
        correlationReason: reasons.join("; "),
        confidenceScore: Math.min(1, Number(score.toFixed(2)))
      });
    }
    return related.sort((a, b) => b.confidenceScore - a.confidenceScore);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/services/correlation.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
cd /path/to/ServiceNow-MCP
git add MCP/src/services/correlation.ts MCP/tests/services/correlation.test.ts
git commit -m "feat: add change correlation scoring service"
```

---

### Task 8: Incident service facade

**Files:**
- Create: `src/services/incidents.ts`
- Test: `tests/services/incidents.test.ts`

This is the orchestrator the tools call. It composes the ServiceNow client, ADO client, and the three pure services. Tests use hand-rolled fakes (plain objects cast to the client types) — no fetch stubbing here.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/services/incidents.test.ts
import { describe, it, expect, vi } from "vitest";
import { IncidentService } from "../../src/services/incidents.js";
import { SlaRiskService } from "../../src/services/slaRisk.js";
import { StaleTicketService } from "../../src/services/staleTickets.js";
import { ChangeCorrelationService } from "../../src/services/correlation.js";
import { ServiceNowClient } from "../../src/clients/servicenow.js";
import { AzureDevOpsClient } from "../../src/clients/ado.js";
import { Incident, ChangeRecord } from "../../src/types.js";

const incident: Incident = {
  number: "INC0001", sysId: "x", priority: "1", state: "New", shortDescription: "DB down",
  openedAt: "2026-06-11T10:00:00Z", updatedAt: "2026-06-11T10:00:00Z", cmdbCi: "db-prod-01"
};

const relatedChange: ChangeRecord = {
  number: "CHG0001", sysId: "c", state: "Closed", shortDescription: "patch",
  cmdbCi: "db-prod-01", actualStartDate: "2026-06-11T09:00:00Z"
};

const window = { beforeHours: 24, afterHours: 4 };

const makeService = (overrides: {
  sn?: Partial<ServiceNowClient>;
  ado?: Partial<AzureDevOpsClient>;
} = {}) => {
  const sn = {
    getIncidentByNumber: vi.fn().mockResolvedValue(incident),
    listIncidents: vi.fn().mockResolvedValue([incident]),
    listChangesWithFilters: vi.fn().mockResolvedValue([relatedChange]),
    ...overrides.sn
  } as unknown as ServiceNowClient;
  const ado = {
    searchWorkItems: vi.fn().mockResolvedValue([{ id: 42, title: "[INC0001] DB down", state: "Active" }]),
    ...overrides.ado
  } as unknown as AzureDevOpsClient;
  return {
    sn, ado,
    svc: new IncidentService(sn, ado, new SlaRiskService(), new StaleTicketService({ "1": 30 }),
      new ChangeCorrelationService(window), window)
  };
};

describe("IncidentService", () => {
  it("summarizeIncident combines incident, correlated changes, and ADO items", async () => {
    const { svc, sn } = makeService();
    const result = await svc.summarizeIncident("INC0001");
    expect(result.incident.number).toBe("INC0001");
    expect(result.relatedChanges[0].changeNumber).toBe("CHG0001");
    expect(result.relatedWorkItems[0].id).toBe(42);
    // change candidates fetched from a window starting beforeHours before openedAt
    expect((sn.listChangesWithFilters as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      startedAfter: "2026-06-10T10:00:00.000Z", limit: 200
    });
  });

  it("summarizeIncident throws when incident not found", async () => {
    const { svc } = makeService({ sn: { getIncidentByNumber: vi.fn().mockResolvedValue(null) } });
    await expect(svc.summarizeIncident("INC9999")).rejects.toThrow(/INC9999 not found/);
  });

  it("summarizeIncident survives ADO search failure", async () => {
    const { svc } = makeService({ ado: { searchWorkItems: vi.fn().mockRejectedValue(new Error("ADO down")) } });
    const result = await svc.summarizeIncident("INC0001");
    expect(result.relatedWorkItems).toEqual([]);
    expect(result.relatedChanges).toHaveLength(1);
  });

  it("listSlaRisks filters by priorities client-side", async () => {
    const p2 = { ...incident, number: "INC-P2", priority: "2", slaDue: "2026-06-11T10:30:00Z" };
    const { svc } = makeService({ sn: { listIncidents: vi.fn().mockResolvedValue([incident, p2]) } });
    const risks = await svc.listSlaRisks({ onlyOpen: true, priorities: ["2"] });
    expect(risks.every((r) => r.priority === "2")).toBe(true);
  });

  it("listStaleIncidents delegates to stale service over open incidents", async () => {
    const staleInc = { ...incident, updatedAt: "2026-06-11T00:00:00Z" };
    const { svc, sn } = makeService({ sn: { listIncidents: vi.fn().mockResolvedValue([staleInc]) } });
    const stale = await svc.listStaleIncidents({ onlyOpen: true, assignmentGroup: "Platform SRE" });
    expect(stale).toHaveLength(1);
    expect((sn.listIncidents as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual({
      onlyOpen: true, assignmentGroup: "Platform SRE"
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/services/incidents.test.ts`
Expected: FAIL — `Cannot find module '../../src/services/incidents.js'`

- [ ] **Step 3: Write `src/services/incidents.ts`**

```typescript
import { Incident, RelatedChange, SlaRiskItem, StaleTicketItem, WorkItem } from "../types.js";
import { ServiceNowClient } from "../clients/servicenow.js";
import { AzureDevOpsClient } from "../clients/ado.js";
import { SlaRiskService } from "./slaRisk.js";
import { StaleTicketService } from "./staleTickets.js";
import { ChangeCorrelationService } from "./correlation.js";

const HOUR_MS = 3_600_000;

export interface IncidentQueryFilters {
  onlyOpen?: boolean;
  assignmentGroup?: string;
  priorities?: string[];
}

export interface IncidentSummary {
  incident: Incident;
  relatedChanges: RelatedChange[];
  relatedWorkItems: WorkItem[];
}

export class IncidentService {
  constructor(
    private readonly serviceNow: ServiceNowClient,
    private readonly ado: AzureDevOpsClient,
    private readonly slaRisk: SlaRiskService,
    private readonly staleTickets: StaleTicketService,
    private readonly correlation: ChangeCorrelationService,
    private readonly window: { beforeHours: number; afterHours: number }
  ) {}

  async summarizeIncident(number: string): Promise<IncidentSummary> {
    const incident = await this.serviceNow.getIncidentByNumber(number);
    if (!incident) throw new Error(`Incident ${number} not found`);
    const relatedChanges = await this.correlateFor(incident);
    let relatedWorkItems: WorkItem[] = [];
    try {
      relatedWorkItems = await this.ado.searchWorkItems({ text: number });
    } catch {
      // ADO failure must not break the incident summary
    }
    return { incident, relatedChanges, relatedWorkItems };
  }

  async findRelatedChanges(number: string): Promise<RelatedChange[]> {
    const incident = await this.serviceNow.getIncidentByNumber(number);
    if (!incident) throw new Error(`Incident ${number} not found`);
    return this.correlateFor(incident);
  }

  async listSlaRisks(filters: IncidentQueryFilters): Promise<SlaRiskItem[]> {
    return this.slaRisk.assess(await this.fetchIncidents(filters));
  }

  async listStaleIncidents(filters: IncidentQueryFilters): Promise<StaleTicketItem[]> {
    return this.staleTickets.findStale(await this.fetchIncidents(filters));
  }

  private async correlateFor(incident: Incident): Promise<RelatedChange[]> {
    const startedAfter = new Date(Date.parse(incident.openedAt) - this.window.beforeHours * HOUR_MS).toISOString();
    const changes = await this.serviceNow.listChangesWithFilters({ startedAfter, limit: 200 });
    return this.correlation.correlate(incident, changes);
  }

  private async fetchIncidents(filters: IncidentQueryFilters): Promise<Incident[]> {
    const incidents = await this.serviceNow.listIncidents({
      onlyOpen: filters.onlyOpen ?? true,
      assignmentGroup: filters.assignmentGroup
    });
    return filters.priorities?.length
      ? incidents.filter((i) => filters.priorities!.includes(i.priority))
      : incidents;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/services/incidents.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
cd /path/to/ServiceNow-MCP
git add MCP/src/services/incidents.ts MCP/tests/services/incidents.test.ts
git commit -m "feat: add incident service facade"
```

---

### Task 9: Report service

**Files:**
- Create: `src/services/report.ts`
- Test: `tests/services/report.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/services/report.test.ts
import { describe, it, expect, vi } from "vitest";
import { ReportService } from "../../src/services/report.js";
import { IncidentService } from "../../src/services/incidents.js";
import { ServiceNowClient } from "../../src/clients/servicenow.js";
import { Incident, ChangeRecord, SlaRiskItem, StaleTicketItem } from "../../src/types.js";

const now = new Date("2026-06-11T12:00:00Z");

const inc = (number: string, priority: string): Incident => ({
  number, sysId: "x", priority, state: "In Progress", shortDescription: "t",
  openedAt: "2026-06-11T08:00:00Z", updatedAt: "2026-06-11T11:00:00Z"
});

const chg = (number: string, overrides: Partial<ChangeRecord>): ChangeRecord => ({
  number, sysId: "c", state: "Scheduled", shortDescription: "t", ...overrides
});

const slaRisk: SlaRiskItem = {
  incidentNumber: "INC-P1", priority: "1", slaDue: "2026-06-11T12:30:00Z",
  remainingMinutes: 30, riskLevel: "Critical", suggestedAction: "Escalate immediately"
};
const staleTicket: StaleTicketItem = {
  incidentNumber: "INC-STALE", priority: "2", lastUpdated: "2026-06-11T08:00:00Z",
  staleByMinutes: 60, thresholdMinutes: 120
};

describe("ReportService", () => {
  it("aggregates counts, majors, change buckets, and actions", async () => {
    const sn = {
      listIncidents: vi.fn().mockResolvedValue([inc("INC-P1", "1"), inc("INC-P2", "2"), inc("INC-P2B", "2")]),
      listChangesWithFilters: vi.fn().mockResolvedValue([
        chg("CHG-FAILED", { state: "Failed", actualStartDate: "2026-06-11T06:00:00Z" }),
        chg("CHG-HIGHRISK", { risk: "High", actualStartDate: "2026-06-11T07:00:00Z" }),
        chg("CHG-UPCOMING", { plannedStartDate: "2026-06-11T20:00:00Z" }),
        chg("CHG-NORMAL", { risk: "Low", actualStartDate: "2026-06-11T05:00:00Z" })
      ])
    } as unknown as ServiceNowClient;
    const incidents = {
      listSlaRisks: vi.fn().mockResolvedValue([slaRisk]),
      listStaleIncidents: vi.fn().mockResolvedValue([staleTicket])
    } as unknown as IncidentService;

    const report = await new ReportService(incidents, sn).generateDailyOpsReport(now);

    expect(report.generatedForDate).toBe("2026-06-11");
    expect(report.openIncidentsByPriority).toEqual({ "1": 1, "2": 2 });
    expect(report.majorIncidents.map((i) => i.number)).toEqual(["INC-P1"]);
    expect(report.failedOrHighRiskChanges.map((c) => c.number)).toEqual(["CHG-FAILED", "CHG-HIGHRISK"]);
    expect(report.upcomingChanges.map((c) => c.number)).toEqual(["CHG-UPCOMING"]);
    expect(report.recommendedActions.some((a) => a.includes("INC-P1"))).toBe(true);
    expect(report.recommendedActions.some((a) => a.includes("INC-STALE"))).toBe(true);
    expect(report.executiveSummary).toContain("3 open incidents");
    expect(report.executiveSummary).toContain("1 P1");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/services/report.test.ts`
Expected: FAIL — `Cannot find module '../../src/services/report.js'`

- [ ] **Step 3: Write `src/services/report.ts`**

```typescript
import { DailyOpsReport } from "../types.js";
import { ServiceNowClient } from "../clients/servicenow.js";
import { IncidentService } from "./incidents.js";

const HOUR_MS = 3_600_000;

export class ReportService {
  constructor(
    private readonly incidents: IncidentService,
    private readonly serviceNow: ServiceNowClient
  ) {}

  async generateDailyOpsReport(now: Date = new Date()): Promise<DailyOpsReport> {
    const open = await this.serviceNow.listIncidents({ onlyOpen: true });
    const slaRisks = await this.incidents.listSlaRisks({ onlyOpen: true });
    const staleIncidents = await this.incidents.listStaleIncidents({ onlyOpen: true });
    const dayAgo = new Date(now.getTime() - 24 * HOUR_MS).toISOString();
    const recentChanges = await this.serviceNow.listChangesWithFilters({ startedAfter: dayAgo, limit: 200 });

    const openIncidentsByPriority: Record<string, number> = {};
    for (const i of open) {
      openIncidentsByPriority[i.priority] = (openIncidentsByPriority[i.priority] ?? 0) + 1;
    }

    const majorIncidents = open.filter((i) => i.priority === "1");
    const failedOrHighRiskChanges = recentChanges.filter(
      (c) => c.risk?.toLowerCase() === "high" || ["failed", "cancelled", "canceled"].includes(c.state.toLowerCase())
    );
    const upcomingChanges = recentChanges.filter((c) => {
      const start = c.plannedStartDate ? Date.parse(c.plannedStartDate) : NaN;
      return Number.isFinite(start) && start > now.getTime() && start <= now.getTime() + 24 * HOUR_MS;
    });

    const recommendedActions = [
      ...slaRisks.slice(0, 5).map((r) => `${r.incidentNumber}: ${r.suggestedAction}`),
      ...staleIncidents
        .filter((t) => t.priority === "1" || t.priority === "2")
        .slice(0, 5)
        .map((t) => `${t.incidentNumber}: add work notes — ${t.staleByMinutes} min past update threshold`)
    ];

    const executiveSummary =
      `${open.length} open incidents (${majorIncidents.length} P1). ` +
      `${slaRisks.length} at SLA risk, ${staleIncidents.length} stale. ` +
      `${failedOrHighRiskChanges.length} failed/high-risk changes in the last 24h, ` +
      `${upcomingChanges.length} changes planned in the next 24h.`;

    return {
      generatedAt: now.toISOString(),
      generatedForDate: now.toISOString().slice(0, 10),
      executiveSummary,
      openIncidentsByPriority,
      slaRisks,
      staleIncidents,
      majorIncidents,
      failedOrHighRiskChanges,
      upcomingChanges,
      recommendedActions
    };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/services/report.test.ts`
Expected: PASS (1 test)

- [ ] **Step 5: Commit**

```bash
cd /path/to/ServiceNow-MCP
git add MCP/src/services/report.ts MCP/tests/services/report.test.ts
git commit -m "feat: add daily ops report service"
```

---

### Task 10: Rewire runtime, fix imports, full build

**Files:**
- Rewrite: `src/runtime.ts` (replace entire file)
- Modify: `src/resources/incidents.ts:3` (import line only)
- Modify: `src/resources/changes.ts:3` (import line only)

- [ ] **Step 1: Replace `src/runtime.ts` entirely with:**

```typescript
import { loadConfig, AppConfig } from "./config.js";
import { ServiceNowClient } from "./clients/servicenow.js";
import { AzureDevOpsClient } from "./clients/ado.js";
import { SlaRiskService } from "./services/slaRisk.js";
import { StaleTicketService } from "./services/staleTickets.js";
import { ChangeCorrelationService } from "./services/correlation.js";
import { IncidentService } from "./services/incidents.js";
import { ReportService } from "./services/report.js";

export interface McpRuntime {
  config: AppConfig;
  serviceNowClient: ServiceNowClient;
  azureDevOpsClient: AzureDevOpsClient;
  incidentService: IncidentService;
  reportService: ReportService;
  slaRiskService: SlaRiskService;
  staleTicketService: StaleTicketService;
  correlationService: ChangeCorrelationService;
}

export const createMcpRuntime = (): McpRuntime => {
  const config = loadConfig();

  const serviceNowClient = new ServiceNowClient(config.serviceNow);
  const azureDevOpsClient = new AzureDevOpsClient(config.azureDevOps);

  const slaRiskService = new SlaRiskService();
  const staleTicketService = new StaleTicketService(config.thresholds.staleByPriorityMinutes);
  const correlationService = new ChangeCorrelationService(config.thresholds.relatedChangeWindow);

  const incidentService = new IncidentService(
    serviceNowClient,
    azureDevOpsClient,
    slaRiskService,
    staleTicketService,
    correlationService,
    config.thresholds.relatedChangeWindow
  );
  const reportService = new ReportService(incidentService, serviceNowClient);

  return {
    config,
    serviceNowClient,
    azureDevOpsClient,
    incidentService,
    reportService,
    slaRiskService,
    staleTicketService,
    correlationService
  };
};
```

- [ ] **Step 2: Fix the two type imports**

In `src/resources/incidents.ts` line 3, change:
```typescript
import { Incident } from "../../dist/models/types.js";
```
to:
```typescript
import { Incident } from "../types.js";
```

In `src/resources/changes.ts` line 3, change:
```typescript
import { ChangeRecord } from "../../dist/models/types.js";
```
to:
```typescript
import { ChangeRecord } from "../types.js";
```

- [ ] **Step 3: Full build**

Run: `npm run build`
Expected: exit 0, no errors, `dist/index.js` exists.

If errors surface in untouched consumer files, the new code's types don't match consumer expectations — fix the NEW code (types/services), never the consumers. Exception: `noImplicitAny` is `false` in tsconfig, so loose handler params in consumers won't error.

- [ ] **Step 4: Run full test suite**

Run: `npm test`
Expected: PASS — all suites (config 6, servicenow 7, ado 7, slaRisk 4, staleTickets 4, correlation 5, incidents 5, report 1 = 39 tests).

- [ ] **Step 5: Startup smoke test (no credentials → clean config error)**

Run: `node dist/index.js 2>&1 | head -5; true`
Expected: stderr contains `[sre-ops-mcp] Fatal error:` and `SERVICENOW_BASE_URL` — fail-fast works.

Run:
```bash
echo "" | SERVICENOW_BASE_URL=https://example.service-now.com SERVICENOW_USERNAME=u SERVICENOW_PASSWORD=p node dist/index.js 2>&1 | head -3
```
Expected: `[sre-ops-mcp] Server started` and `ServiceNow: enabled` on stderr (server starts, then exits on stdin EOF).

- [ ] **Step 6: Commit**

```bash
cd /path/to/ServiceNow-MCP
git add MCP/src/runtime.ts MCP/src/resources/incidents.ts MCP/src/resources/changes.ts
git commit -m "feat: rewire runtime to standalone service layer"
```

---

### Task 11: README update + final verification

**Files:**
- Modify: `MCP/README.md`

- [ ] **Step 1: Update README**

Read `MCP/README.md` first. Then:
1. Replace any environment-variable/configuration section with the table below.
2. Remove all references to SREOps, `ENABLE_SERVICENOW_INTEGRATION`, mock clients, and mock data (including in the Troubleshooting section — the line "Test with `ENABLE_SERVICENOW_INTEGRATION=false` to use mock data" must go).
3. Replace the "Architecture" diagram text "Existing Services" with "Built-in Services" (the layer diagram itself still applies).
4. Keep MCP client config examples (`mcp.json`) but ensure their `env` blocks use the variables below.

Environment variable table for the README:

```markdown
## Configuration

All configuration is via environment variables (set them in the `env` block of your MCP client config).

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SERVICENOW_BASE_URL` | yes | — | e.g. `https://yourcompany.service-now.com` |
| `SERVICENOW_USERNAME` | yes | — | Basic auth user |
| `SERVICENOW_PASSWORD` | yes | — | Basic auth password |
| `ADO_ENABLED` | no | `false` | Enable Azure DevOps integration |
| `ADO_ORG_URL` | if ADO enabled | — | e.g. `https://dev.azure.com/yourorg` |
| `ADO_PROJECT` | if ADO enabled | — | ADO project name |
| `ADO_PAT` | if ADO enabled | — | Personal Access Token (Work Items read/write) |
| `ADO_AREA_PATH` | no | project name | Default area path for created bugs |
| `ADO_ITERATION_PATH` | no | project name | Default iteration path for created bugs |
| `ADO_ASSIGNED_TEAM` | no | — | Default team for created bugs |
| `ADO_CREATE_BUG_ENABLED` | no | `true` | Feature flag for `create_bug_from_incident` |
| `STALE_P1_MIN` / `STALE_P2_MIN` / `STALE_P3_MIN` / `STALE_P4_MIN` | no | 30 / 120 / 1440 / 4320 | Stale thresholds (minutes) |
| `CORRELATION_HOURS_BEFORE` / `CORRELATION_HOURS_AFTER` | no | 24 / 4 | Change correlation window around incident open time |
```

- [ ] **Step 2: Final verification**

```bash
cd /path/to/ServiceNow-MCP/MCP
npm run build && npm test
```
Expected: build exit 0, all 39 tests pass.

```bash
grep -rn "ENABLE_SERVICENOW_INTEGRATION\|SREOps\|mock data\|MockServiceNow" README.md || echo CLEAN
```
Expected: `CLEAN`

- [ ] **Step 3: Commit**

```bash
cd /path/to/ServiceNow-MCP
git add MCP/README.md
git commit -m "docs: update README for standalone configuration"
```

---

## Post-plan: live verification (manual, with user)

Not part of automated execution — needs real credentials:
1. Add server to MCP client config with real `SERVICENOW_*` env vars.
2. Verify `search_incidents` and `get_incident` return real data.
3. If field mismatches appear (e.g. instance lacks `sla_due` or uses custom states), adjust `INCIDENT_FIELDS` / `OPEN_INCIDENT_QUERY` in `src/clients/servicenow.ts` — both are single constants at the top of the file.
4. With `ADO_ENABLED=true` and real PAT: verify `search_work_items`, then `create_bug_from_incident` (creates a real bug — confirm with user first).
