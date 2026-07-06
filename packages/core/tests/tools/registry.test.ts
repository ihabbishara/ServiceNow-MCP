import { describe, it, expect, vi } from "vitest";
import { TOOL_SPECS, WRITE_TOOL_NAMES, ToolError } from "../../src/tools/registry.js";

describe("ado specs (drift fixes)", () => {
  const spec = (n: string) => TOOL_SPECS.find((s) => s.name === n)!;
  const cfg = (enabled: boolean, createAdoBug = true): any => ({
    azureDevOps: { enabled },
    features: { createAdoBug }
  });

  it("registers all five ADO tools with correct write flags", () => {
    for (const n of ["search_work_items", "get_work_item"]) expect(spec(n).write).toBeFalsy();
    for (const n of ["create_bug_from_incident", "create_work_item", "clone_work_item"])
      expect(spec(n).write).toBe(true);
  });

  // Drift fix 1: the guard exists ONCE and covers both surfaces via enabledWhen.
  it("create_bug_from_incident is disabled when ADO is off OR the feature flag is off", () => {
    expect(spec("create_bug_from_incident").enabledWhen!(cfg(false))).toBe(
      "ADO integration is disabled. Enable it to create bugs."
    );
    expect(spec("create_bug_from_incident").enabledWhen!(cfg(true, false))).toBe(
      "ADO bug creation is disabled by feature flag."
    );
    expect(spec("create_bug_from_incident").enabledWhen!(cfg(true, true))).toBeNull();
  });

  // Drift fix 2: one unified search spec.
  it("search_work_items has optional query_text, the five filters, an ADO guard, and the 10-field projection", async () => {
    const s = spec("search_work_items");
    expect(Object.keys(s.schema).sort()).toEqual(
      ["query_text", "work_item_type", "state", "area_path", "assigned_to"].sort()
    );
    expect(s.schema.query_text.safeParse(undefined).success).toBe(true);
    expect(s.enabledWhen!(cfg(false))).toMatch(/disabled/);

    const w = {
      id: 1,
      title: "t",
      workItemType: "Bug",
      state: "Active",
      assignedTo: "u",
      areaPath: "a",
      iterationPath: "i",
      priority: 2,
      storyPoints: 3,
      parentId: 9,
      tags: ["x"],
      url: "http://SHOULD-NOT-APPEAR"
    };
    const rt: any = { azureDevOpsClient: { searchWorkItems: vi.fn(async () => [w]) } };
    const out = (await s.run(rt, {})) as any;
    expect(out.workItems[0]).toEqual({
      id: 1,
      title: "t",
      workItemType: "Bug",
      state: "Active",
      assignedTo: "u",
      areaPath: "a",
      iterationPath: "i",
      priority: 2,
      storyPoints: 3,
      tags: ["x"]
    });
  });

  it("get_work_item throws ToolError when not found", async () => {
    const rt: any = { azureDevOpsClient: { getWorkItem: vi.fn(async () => null) } };
    await expect(spec("get_work_item").run(rt, { id: 404 })).rejects.toThrow(
      "Work item 404 not found"
    );
  });

  it("create_work_item surfaces a boardWarning for unknown boards", async () => {
    const rt: any = {
      workItemService: {
        isBoardKnown: vi.fn(() => false),
        create: vi.fn(async () => ({
          id: 100,
          title: "T",
          workItemType: "Task",
          areaPath: "Default"
        }))
      }
    };
    const out = (await spec("create_work_item").run(rt, {
      type: "Task",
      title: "T",
      board: "ghost"
    })) as any;
    expect(out.boardWarning).toContain('"ghost"');
    expect(out).toMatchObject({ success: true, id: 100 });
  });
});

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

describe("knowledge + sharepoint specs", () => {
  const spec = (n: string) => TOOL_SPECS.find((s) => s.name === n)!;

  it("registers the groups", () => {
    const names = TOOL_SPECS.map((s) => s.name);
    expect(names).toEqual(
      expect.arrayContaining(["search_knowledge", "index_url", "get_incident_documents"])
    );
  });

  it("index_url clamps depth to 2 and pages to 25", async () => {
    const crawl = vi.fn(async () => ({ pagesCrawled: 1, chunksAdded: 2, pagesSkipped: 0 }));
    const rt: any = { knowledge: { crawl } };
    const out = await spec("index_url").run(rt, { url: "https://w", depth: 9, max_pages: 999 });
    expect(crawl).toHaveBeenCalledWith(
      { seeds: ["https://w"], maxDepth: 2, maxPages: 25 },
      expect.any(Function)
    );
    expect(out).toEqual({ pages_crawled: 1, chunks_added: 2, skipped: 0 });
  });

  it("get_incident_documents is disabled by config and guarded at runtime", async () => {
    const sp = spec("get_incident_documents");
    expect(sp.enabledWhen!({ sharePoint: { enabled: false } } as any)).toMatch(/disabled/);
    expect(sp.enabledWhen!({ sharePoint: { enabled: true } } as any)).toBeNull();
    await expect(sp.run({ sharePoint: undefined } as any, { incident: "INC1" })).rejects.toThrow(
      "SharePoint integration is disabled (set SHAREPOINT_ENABLED=true)."
    );
  });
});

describe("workItemCsv specs", () => {
  const spec = (n: string) => TOOL_SPECS.find((s) => s.name === n)!;

  it("registers both CSV tools as reads", () => {
    expect(spec("list_work_item_csvs").write).toBeFalsy();
    expect(spec("read_work_item_csv").write).toBeFalsy();
  });

  it("guards on ADO enabled then on csvDir", () => {
    const g = spec("list_work_item_csvs").enabledWhen!;
    expect(g({ azureDevOps: { enabled: false } } as any)).toBe(
      "Azure DevOps integration is disabled. Set ADO_ENABLED=true."
    );
    expect(g({ azureDevOps: { enabled: true, csvDir: undefined } } as any)).toBe(
      "CSV folder not configured. Set ADO_CSV_DIR to a folder of .csv files."
    );
    expect(g({ azureDevOps: { enabled: true, csvDir: "/tmp/csv" } } as any)).toBeNull();
  });

  it("the registry holds exactly the 23 tools", () => {
    expect(TOOL_SPECS.map((s) => s.name).sort()).toEqual(
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
