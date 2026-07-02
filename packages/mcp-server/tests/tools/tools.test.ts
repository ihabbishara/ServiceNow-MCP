import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerChangeTools } from "../../src/tools/changes.js";
import { registerAdoTools } from "../../src/tools/ado.js";
import { registerAnalysisTools } from "../../src/tools/analysis.js";
import { McpRuntime } from "@sre/core";

// Builds a runtime whose methods are vi mocks; pass overrides to shape responses.
const makeRuntime = (over: Record<string, unknown> = {}) => {
  const fns = {
    listChangesWithFilters: vi.fn().mockResolvedValue([]),
    findRelatedChanges: vi.fn().mockResolvedValue([]),
    searchWorkItems: vi.fn().mockResolvedValue([]),
    generateDailyOpsReport: vi.fn().mockResolvedValue({
      generatedAt: "2026-06-11T12:00:00Z",
      generatedForDate: "2026-06-11",
      executiveSummary: "x",
      openIncidentsByPriority: {},
      slaRisks: [],
      staleIncidents: [],
      majorIncidents: [],
      failedOrHighRiskChanges: [],
      upcomingChanges: [],
      recommendedActions: []
    }),
    ...over
  };
  const runtime = {
    config: {
      azureDevOps: { enabled: true },
      features: { createAdoBug: true },
      thresholds: { relatedChangeWindow: { beforeHours: 24, afterHours: 4 } }
    },
    serviceNowClient: { listChangesWithFilters: fns.listChangesWithFilters },
    azureDevOpsClient: { searchWorkItems: fns.searchWorkItems },
    incidentService: { findRelatedChanges: fns.findRelatedChanges },
    reportService: { generateDailyOpsReport: fns.generateDailyOpsReport }
  } as unknown as McpRuntime;
  return { runtime, fns };
};

const connect = async (runtime: McpRuntime) => {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerChangeTools(server, runtime);
  registerAdoTools(server, runtime);
  registerAnalysisTools(server, runtime);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0.0.0" });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
};

const callJson = async (client: Client, name: string, args: Record<string, unknown>) => {
  const res = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
  return { isError: res.isError ?? false, text: res.content[0].text };
};

describe("search_changes tool", () => {
  it("pushes started_before to the server and does not drop no-start changes client-side", async () => {
    const noStart = { number: "CHG-NOSTART", state: "New", shortDescription: "t", risk: "Low" };
    const { runtime, fns } = makeRuntime({
      listChangesWithFilters: vi.fn().mockResolvedValue([noStart])
    });
    const client = await connect(runtime);
    const { text } = await callJson(client, "search_changes", {
      started_before: "2026-06-10T00:00:00Z"
    });
    expect(fns.listChangesWithFilters).toHaveBeenCalledWith(
      expect.objectContaining({ startedBefore: "2026-06-10T00:00:00Z" })
    );
    // No client-side date filter remains, so whatever the server returned is reported verbatim.
    expect(JSON.parse(text).count).toBe(1);
  });
});

describe("correlate_changes tool", () => {
  it("passes a caller-supplied window through to findRelatedChanges", async () => {
    const { runtime, fns } = makeRuntime();
    const client = await connect(runtime);
    await callJson(client, "correlate_changes", {
      incident_number: "INC0001",
      window_hours_before: 12,
      window_hours_after: 1
    });
    expect(fns.findRelatedChanges).toHaveBeenCalledWith("INC0001", {
      beforeHours: 12,
      afterHours: 1
    });
  });

  it("fills the unspecified bound from config defaults", async () => {
    const { runtime, fns } = makeRuntime();
    const client = await connect(runtime);
    await callJson(client, "correlate_changes", {
      incident_number: "INC0001",
      window_hours_before: 6
    });
    expect(fns.findRelatedChanges).toHaveBeenCalledWith("INC0001", {
      beforeHours: 6,
      afterHours: 4
    });
  });

  it("passes undefined window when no override is given", async () => {
    const { runtime, fns } = makeRuntime();
    const client = await connect(runtime);
    await callJson(client, "correlate_changes", { incident_number: "INC0001" });
    expect(fns.findRelatedChanges).toHaveBeenCalledWith("INC0001", undefined);
  });
});

describe("search_work_items tool", () => {
  it("returns an error (not empty results) when ADO is disabled", async () => {
    const { runtime, fns } = makeRuntime();
    (runtime.config.azureDevOps as { enabled: boolean }).enabled = false;
    const client = await connect(runtime);
    const { isError, text } = await callJson(client, "search_work_items", {
      query_text: "INC0001"
    });
    expect(isError).toBe(true);
    expect(text).toMatch(/disabled/i);
    expect(fns.searchWorkItems).not.toHaveBeenCalled();
  });

  it("returns results when ADO is enabled", async () => {
    const { runtime } = makeRuntime({
      searchWorkItems: vi.fn().mockResolvedValue([{ id: 7, title: "t", state: "Active" }])
    });
    const client = await connect(runtime);
    const { isError, text } = await callJson(client, "search_work_items", {
      query_text: "INC0001"
    });
    expect(isError).toBe(false);
    expect(JSON.parse(text).count).toBe(1);
  });
});

describe("generate_ops_summary tool", () => {
  it("passes parsed date and assignment_group to the report service", async () => {
    const { runtime, fns } = makeRuntime();
    const client = await connect(runtime);
    await callJson(client, "generate_ops_summary", {
      date: "2026-06-11",
      assignment_group: "Platform SRE"
    });
    const arg = (fns.generateDailyOpsReport as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.assignmentGroup).toBe("Platform SRE");
    expect(arg.now.toISOString().slice(0, 10)).toBe("2026-06-11");
  });

  it("rejects an unparseable date without calling the report service", async () => {
    const { runtime, fns } = makeRuntime();
    const client = await connect(runtime);
    const { isError, text } = await callJson(client, "generate_ops_summary", {
      date: "not-a-date"
    });
    expect(isError).toBe(true);
    expect(text).toMatch(/Invalid date/);
    expect(fns.generateDailyOpsReport).not.toHaveBeenCalled();
  });
});
