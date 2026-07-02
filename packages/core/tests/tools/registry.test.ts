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
