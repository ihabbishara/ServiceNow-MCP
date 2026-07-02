import { describe, it, expect, vi } from "vitest";
import { TOOL_SPECS, WRITE_TOOL_NAMES, ToolError } from "../../src/tools/registry.js";

describe("TOOL_SPECS registry", () => {
  it("has unique names and complete metadata", () => {
    const names = TOOL_SPECS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    for (const s of TOOL_SPECS) {
      expect(s.name).toMatch(/^[a-z_]+$/);
      expect(s.description.length).toBeGreaterThan(10);
      expect(typeof s.schema).toBe("object");
      expect(typeof s.run).toBe("function");
    }
  });

  it("derives WRITE_TOOL_NAMES from write flags", () => {
    const expected = TOOL_SPECS.filter((s) => s.write).map((s) => s.name);
    expect([...WRITE_TOOL_NAMES].sort()).toEqual(expected.sort());
  });

  it("contains the incidents group", () => {
    const names = TOOL_SPECS.map((s) => s.name);
    expect(names).toEqual(
      expect.arrayContaining(["search_incidents", "get_incident", "summarize_incident"])
    );
  });
});

describe("incidents specs", () => {
  const spec = (n: string) => TOOL_SPECS.find((s) => s.name === n)!;

  it("search_incidents rejects unassigned_only + assigned_to with a ToolError", async () => {
    const rt: any = { serviceNowClient: { listIncidentsWithFilters: vi.fn() } };
    await expect(
      spec("search_incidents").run(rt, { unassigned_only: true, assigned_to: "x" })
    ).rejects.toThrow(ToolError);
  });

  it("search_incidents projects the 8-field incident brief", async () => {
    const inc = {
      number: "INC1",
      priority: "2",
      state: "New",
      shortDescription: "s",
      assignedTo: undefined,
      assignmentGroup: "g",
      openedAt: "o",
      updatedAt: "u",
      description: "SHOULD NOT APPEAR"
    };
    const rt: any = { serviceNowClient: { listIncidentsWithFilters: vi.fn(async () => [inc]) } };
    const out = (await spec("search_incidents").run(rt, {})) as any;
    expect(out.count).toBe(1);
    expect(out.incidents[0]).toEqual({
      number: "INC1",
      priority: "2",
      state: "New",
      shortDescription: "s",
      assignedTo: null,
      assignmentGroup: "g",
      openedAt: "o",
      updatedAt: "u"
    });
  });

  it("get_incident throws ToolError when not found", async () => {
    const rt: any = { serviceNowClient: { getIncidentByNumber: vi.fn(async () => null) } };
    await expect(spec("get_incident").run(rt, { number: "INC0" })).rejects.toThrow(
      "Incident INC0 not found"
    );
  });
});

describe("analysis specs", () => {
  const spec = (n: string) => TOOL_SPECS.find((s) => s.name === n)!;

  it("registers the analysis group", () => {
    const names = TOOL_SPECS.map((s) => s.name);
    expect(names).toEqual(
      expect.arrayContaining(["find_sla_risks", "find_stale_tickets", "generate_ops_summary"])
    );
  });

  it("find_sla_risks applies the minimum risk-level filter", async () => {
    const risks = [
      { incidentNumber: "I1", riskLevel: "Critical" },
      { incidentNumber: "I2", riskLevel: "Medium" }
    ];
    const rt: any = { incidentService: { listSlaRisks: vi.fn(async () => risks) } };
    const out = (await spec("find_sla_risks").run(rt, { risk_level: "High" })) as any;
    expect(out.count).toBe(1);
    expect(out.risks[0].incidentNumber).toBe("I1");
  });

  it("generate_ops_summary rejects an invalid date with ToolError", async () => {
    const rt: any = { reportService: { generateDailyOpsReport: vi.fn() } };
    await expect(spec("generate_ops_summary").run(rt, { date: "not-a-date" })).rejects.toThrow(
      ToolError
    );
  });
});

describe("changes specs", () => {
  const spec = (n: string) => TOOL_SPECS.find((s) => s.name === n)!;

  it("registers the changes group", () => {
    const names = TOOL_SPECS.map((s) => s.name);
    expect(names).toEqual(
      expect.arrayContaining(["search_changes", "get_change", "correlate_changes"])
    );
  });

  it("search_changes filters risk client-side", async () => {
    const rows = [
      { number: "C1", state: "New", shortDescription: "a", risk: "High" },
      { number: "C2", state: "New", shortDescription: "b", risk: "Low" }
    ];
    const rt: any = { serviceNowClient: { listChangesWithFilters: vi.fn(async () => rows) } };
    const out = (await spec("search_changes").run(rt, { risk: "High" })) as any;
    expect(out.count).toBe(1);
    expect(out.changes[0].number).toBe("C1");
  });

  it("get_change throws ToolError when not found", async () => {
    const rt: any = { serviceNowClient: { getChangeByNumber: vi.fn(async () => null) } };
    await expect(spec("get_change").run(rt, { number: "CHG0" })).rejects.toThrow(
      "Change CHG0 not found"
    );
  });

  it("correlate_changes passes undefined window when neither bound is set", async () => {
    const findRelatedChanges = vi.fn(async () => []);
    const rt: any = {
      config: { thresholds: { relatedChangeWindow: { beforeHours: 24, afterHours: 4 } } },
      incidentService: { findRelatedChanges }
    };
    await spec("correlate_changes").run(rt, { incident_number: "INC1" });
    expect(findRelatedChanges).toHaveBeenCalledWith("INC1", undefined);
  });
});
