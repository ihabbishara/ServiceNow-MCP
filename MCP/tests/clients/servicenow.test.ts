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
