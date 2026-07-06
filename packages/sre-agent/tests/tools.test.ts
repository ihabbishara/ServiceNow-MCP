import { describe, it, expect, vi } from "vitest";
import type { Tool } from "@github/copilot-sdk";
import { buildTools, toCopilotTool } from "../src/tools/index.js";
import { TOOL_SPECS } from "@sre/core";

/**
 * Minimal fake runtime: only the methods a given test exercises are stubbed.
 * `config` carries the feature flags the create-bug handler consults.
 */
const fakeRuntime = (overrides: Record<string, unknown> = {}) =>
  ({
    config: {
      features: { createAdoBug: true },
      azureDevOps: {
        enabled: true,
        defaultAreaPath: "IngOne",
        defaultIterationPath: "IngOne",
        defaultAssignedTeam: undefined
      },
      thresholds: { relatedChangeWindow: { beforeHours: 24, afterHours: 4 } }
    },
    serviceNowClient: {
      getIncidentByNumber: vi.fn(async () => null),
      getChangeByNumber: vi.fn(async () => null),
      listIncidentsWithFilters: vi.fn(async () => []),
      listChangesWithFilters: vi.fn(async () => [])
    },
    incidentService: {
      summarizeIncident: vi.fn(async () => ({
        incident: { number: "INC1", priority: "2", shortDescription: "boom" },
        relatedChanges: [],
        relatedWorkItems: []
      })),
      findRelatedChanges: vi.fn(async () => []),
      listSlaRisks: vi.fn(async () => []),
      listStaleIncidents: vi.fn(async () => [])
    },
    reportService: { generateDailyOpsReport: vi.fn(async () => ({})) },
    azureDevOpsClient: {
      getWorkItem: vi.fn(async () => ({ id: 5, title: "S", state: "Active" })),
      searchWorkItems: vi.fn(async () => []),
      createBug: vi.fn(async () => ({ id: 99, title: "[INC1] boom" }))
    },
    ...overrides
  }) as any;

const byName = (rt: any, n: string): Tool<any> => {
  const t = buildTools(rt).find((tool) => tool.name === n);
  if (!t) throw new Error(`tool ${n} not registered`);
  return t;
};

const call = (t: Tool<any>, args: unknown) => t.handler!(args as never, {} as never);

describe("enabledWhen empty-string is treated as disabled (fix #7)", () => {
  it("returns { error: '' } when enabledWhen returns empty string", async () => {
    const spec = {
      name: "test_empty_disabled",
      description: "test",
      schema: {},
      enabledWhen: () => "",
      run: async () => ({ ok: true })
    } as any;
    const tool = toCopilotTool(spec, {} as any);
    const result = await tool.handler!({} as never, {} as never);
    expect(result).toEqual({ error: "" });
  });
});

describe("buildTools", () => {
  it("registers exactly the 23 expected tools", () => {
    const names = buildTools(fakeRuntime())
      .map((t) => t.name)
      .sort();
    expect(names).toEqual(
      [
        "checkout_repo",
        "clone_work_item",
        "correlate_changes",
        "create_bug_from_incident",
        "create_work_item",
        "find_sla_risks",
        "find_stale_tickets",
        "generate_ops_summary",
        "get_change",
        "get_incident",
        "get_incident_documents",
        "get_work_item",
        "index_url",
        "list_work_item_csvs",
        "read_repo_file",
        "read_work_item_csv",
        "repo_history",
        "search_changes",
        "search_incidents",
        "search_knowledge",
        "search_repo",
        "search_work_items",
        "summarize_incident"
      ].sort()
    );
  });

  it("read tools set skipPermission, write tools do not", () => {
    const writeToolNames = new Set([
      "create_bug_from_incident",
      "create_work_item",
      "clone_work_item"
    ]);
    const tools = buildTools(fakeRuntime());
    for (const t of tools) {
      if (writeToolNames.has(t.name)) {
        expect(t.skipPermission).toBeFalsy();
      } else {
        expect(t.skipPermission).toBe(true);
      }
    }
  });

  it("get_incident returns {error} when not found", async () => {
    const t = byName(fakeRuntime(), "get_incident");
    expect(await call(t, { number: "INC0" })).toEqual({
      error: expect.stringMatching(/not found/)
    });
  });

  it("get_incident returns the incident when found", async () => {
    const rt = fakeRuntime();
    rt.serviceNowClient.getIncidentByNumber = vi.fn(async () => ({ number: "INC9" }));
    const t = byName(rt, "get_incident");
    expect(await call(t, { number: "INC9" })).toEqual({ number: "INC9" });
  });

  it("search_work_items maps area_path -> areaPath and assigned_to -> assignedTo", async () => {
    const rt = fakeRuntime();
    const t = byName(rt, "search_work_items");
    await call(t, {
      query_text: "outage",
      work_item_type: "Bug",
      state: "Active",
      area_path: "IngOne\\Team",
      assigned_to: "me@ing.com"
    });
    expect(rt.azureDevOpsClient.searchWorkItems).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "outage",
        workItemType: "Bug",
        state: "Active",
        areaPath: "IngOne\\Team",
        assignedTo: "me@ing.com"
      })
    );
  });

  it("get_work_item returns the item", async () => {
    const t = byName(fakeRuntime(), "get_work_item");
    expect(await call(t, { id: 5 })).toEqual({ id: 5, title: "S", state: "Active" });
  });

  it("get_work_item returns {error} when not found", async () => {
    const rt = fakeRuntime();
    rt.azureDevOpsClient.getWorkItem = vi.fn(async () => null);
    const t = byName(rt, "get_work_item");
    expect(await call(t, { id: 404 })).toEqual({
      error: expect.stringMatching(/not found/)
    });
  });

  it("create_bug_from_incident calls createBug and returns the success projection", async () => {
    const rt = fakeRuntime();
    const t = byName(rt, "create_bug_from_incident");
    const out = (await call(t, { incident_number: "INC1" })) as any;
    expect(rt.azureDevOpsClient.createBug).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "[INC1] boom",
        incidentNumber: "INC1",
        tags: expect.arrayContaining(["ServiceNow", "Incident", "SRE"])
      })
    );
    expect(out).toEqual(
      expect.objectContaining({
        success: true,
        bugId: 99,
        title: "[INC1] boom",
        linkedIncident: "INC1"
      })
    );
  });

  it("handlers return {error} instead of throwing", async () => {
    const rt = fakeRuntime();
    rt.serviceNowClient.getIncidentByNumber = vi.fn(async () => {
      throw new Error("boom");
    });
    const t = byName(rt, "get_incident");
    expect(await call(t, { number: "INC1" })).toEqual({
      error: expect.stringMatching(/boom/)
    });
  });

  it("create_bug_from_incident errors when ADO is disabled (drift fix)", async () => {
    const rt = fakeRuntime();
    rt.config.azureDevOps.enabled = false;
    const t = byName(rt, "create_bug_from_incident");
    expect(await call(t, { incident_number: "INC1" })).toEqual({
      error: "ADO integration is disabled. Enable it to create bugs."
    });
    expect(rt.azureDevOpsClient.createBug).not.toHaveBeenCalled();
  });

  it("search_work_items errors when ADO is disabled (drift fix)", async () => {
    const rt = fakeRuntime();
    rt.config.azureDevOps.enabled = false;
    const t = byName(rt, "search_work_items");
    expect(await call(t, {})).toEqual({ error: expect.stringMatching(/disabled/) });
  });

  it("search_work_items projects tags (drift fix)", async () => {
    const rt = fakeRuntime();
    rt.azureDevOpsClient.searchWorkItems = vi.fn(async () => [
      { id: 1, title: "t", state: "New", tags: ["a"] }
    ]);
    const t = byName(rt, "search_work_items");
    const out = (await call(t, {})) as any;
    expect(out.workItems[0].tags).toEqual(["a"]);
  });
});

describe("registry parity (Copilot surface)", () => {
  it("exposes every registry spec with matching description, permission, and schema keys", () => {
    const tools = buildTools(fakeRuntime());
    for (const spec of TOOL_SPECS) {
      const t: any = tools.find((tool) => tool.name === spec.name);
      expect(t, `registry tool ${spec.name} missing from buildTools`).toBeTruthy();
      expect(t.description).toBe(spec.description);
      expect(Boolean(t.skipPermission)).toBe(!spec.write);
      expect(Object.keys(t.parameters.shape).sort()).toEqual(Object.keys(spec.schema).sort());
    }
  });
});
