import { describe, it, expect, vi } from "vitest";
import { AzBoardsClient } from "../../src/clients/ado/azBoards.js";

const cfg = {
  orgUrl: "https://dev.azure.com/INGCDaaS",
  project: "IngOne",
  azPath: "az",
  defaultAreaPath: "IngOne",
  defaultIterationPath: "IngOne",
  createBugEnabled: true
};

const makeRunner = (impl: (args: string[]) => any) => ({
  json: vi.fn(async (a: string[]) => impl(a))
});

describe("AzBoardsClient", () => {
  it("searchWorkItems builds WIQL with filters and maps results", async () => {
    const runner = makeRunner(() => [
      { id: 1, fields: { "System.Title": "Story A", "System.State": "Active", "System.WorkItemType": "User Story" } }
    ]);
    const client = new AzBoardsClient(cfg as any, runner as any);
    const items = await client.searchWorkItems({
      workItemType: "User Story",
      state: "Active",
      areaPath: "IngOne\\Team"
    });

    const args = (runner.json as any).mock.calls[0][0] as string[];
    expect(args.slice(0, 3)).toEqual(["boards", "query", "--wiql"]);
    const wiql = args[3];
    expect(wiql).toContain("[System.WorkItemType] = 'User Story'");
    expect(wiql).toContain("[System.State] = 'Active'");
    expect(wiql).toContain("[System.AreaPath] UNDER 'IngOne\\Team'");
    expect(args).toContain("--org");
    expect(args).toContain(cfg.orgUrl);
    expect(args).toContain("--project");
    expect(args).toContain(cfg.project);
    expect(items[0].title).toBe("Story A");
  });

  it("escapes single quotes in CONTAINS and supports @Me unquoted", async () => {
    const runner = makeRunner(() => []);
    const client = new AzBoardsClient(cfg as any, runner as any);
    await client.searchWorkItems({ text: "user's", assignedTo: "@Me" });
    const wiql = (runner.json as any).mock.calls[0][0][3] as string;
    expect(wiql).toContain("[System.Title] CONTAINS 'user''s'");
    expect(wiql).toContain("[System.AssignedTo] = @Me");
  });

  it("quotes a concrete assignedTo value", async () => {
    const runner = makeRunner(() => []);
    const client = new AzBoardsClient(cfg as any, runner as any);
    await client.searchWorkItems({ assignedTo: "jane@x.com" });
    const wiql = (runner.json as any).mock.calls[0][0][3] as string;
    expect(wiql).toContain("[System.AssignedTo] = 'jane@x.com'");
  });

  it("caps results at the limit (default 50, max 200)", async () => {
    const rows = Array.from({ length: 120 }, (_, i) => ({ id: i, fields: { "System.Title": `t${i}`, "System.State": "New" } }));
    const runner = makeRunner(() => rows);
    const client = new AzBoardsClient(cfg as any, runner as any);
    const items = await client.searchWorkItems({ limit: 10 });
    expect(items).toHaveLength(10);
  });

  it("getWorkItem calls show --id --expand fields and maps", async () => {
    const runner = makeRunner(() => ({ id: 42, fields: { "System.Title": "X", "System.State": "Active" } }));
    const client = new AzBoardsClient(cfg as any, runner as any);
    const wi = await client.getWorkItem(42);
    const args = (runner.json as any).mock.calls[0][0] as string[];
    expect(args).toEqual([
      "boards", "work-item", "show", "--id", "42", "--expand", "fields", "--org", cfg.orgUrl
    ]);
    expect(wi?.id).toBe(42);
  });

  it("getWorkItem rejects a non-integer id without calling az", async () => {
    const runner = makeRunner(() => ({}));
    const client = new AzBoardsClient(cfg as any, runner as any);
    await expect(client.getWorkItem(1.5)).rejects.toThrow(/integer/);
    expect((runner.json as any).mock.calls).toHaveLength(0);
  });

  it("createBug shells az boards work-item create with mapped fields", async () => {
    const runner = makeRunner(() => ({ id: 99, fields: { "System.Title": "[INC1] t" } }));
    const client = new AzBoardsClient(cfg as any, runner as any);
    const created = await client.createBug({
      title: "[INC1] t",
      description: "a\nb",
      priority: "2",
      incidentNumber: "INC1",
      tags: ["SRE"]
    });
    const args = (runner.json as any).mock.calls[0][0] as string[];
    expect(args.slice(0, 3)).toEqual(["boards", "work-item", "create"]);
    expect(args).toContain("--type");
    expect(args).toContain("Bug");
    expect(args).toContain("--title");
    expect(args).toContain("[INC1] t");
    expect(args).toContain("--fields");
    expect(args).toContain("System.Tags=SRE");
    expect(args).toContain("Microsoft.VSTS.Common.Priority=2");
    expect(args).toContain("Microsoft.VSTS.TCM.ReproSteps=a<br>b");
    expect(created).toEqual({ id: 99, title: "[INC1] t" });
  });

  it("createBug throws when bug creation is disabled, without calling az", async () => {
    const runner = makeRunner(() => ({}));
    const client = new AzBoardsClient({ ...cfg, createBugEnabled: false } as any, runner as any);
    await expect(
      client.createBug({ title: "t", description: "d", incidentNumber: "INC1" })
    ).rejects.toThrow(/disabled/);
    expect((runner.json as any).mock.calls).toHaveLength(0);
  });
});
