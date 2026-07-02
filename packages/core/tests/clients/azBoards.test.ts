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
      {
        id: 1,
        fields: {
          "System.Title": "Story A",
          "System.State": "Active",
          "System.WorkItemType": "User Story"
        }
      }
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
    const rows = Array.from({ length: 120 }, (_, i) => ({
      id: i,
      fields: { "System.Title": `t${i}`, "System.State": "New" }
    }));
    const runner = makeRunner(() => rows);
    const client = new AzBoardsClient(cfg as any, runner as any);
    const items = await client.searchWorkItems({ limit: 10 });
    expect(items).toHaveLength(10);
  });

  it("searchWorkItems includes TOP in WIQL using default limit 50", async () => {
    const runner = makeRunner(() => []);
    const client = new AzBoardsClient(cfg as any, runner as any);
    await client.searchWorkItems({});
    const wiql = (runner.json as any).mock.calls[0][0][3] as string;
    expect(wiql).toMatch(/^SELECT TOP 50 /);
  });

  it("searchWorkItems clamps limit to 200 max in WIQL when limit: 500", async () => {
    const runner = makeRunner(() => []);
    const client = new AzBoardsClient(cfg as any, runner as any);
    await client.searchWorkItems({ limit: 500 });
    const wiql = (runner.json as any).mock.calls[0][0][3] as string;
    expect(wiql).toMatch(/^SELECT TOP 200 /);
  });

  it("listChildren includes TOP 500 in WIQL", async () => {
    const runner = makeRunner(() => [{ id: 5 }]);
    const client = new AzBoardsClient(cfg as any, runner as any);
    await client.listChildren(3);
    const callArgs = (runner.json as any).mock.calls[0][0] as string[];
    const wiql = callArgs[callArgs.indexOf("--wiql") + 1];
    expect(wiql).toContain("TOP 500");
    expect(wiql).toContain("[System.Parent] = 3");
  });

  it("getWorkItem calls show --id --expand fields and maps", async () => {
    const runner = makeRunner(() => ({
      id: 42,
      fields: { "System.Title": "X", "System.State": "Active" }
    }));
    const client = new AzBoardsClient(cfg as any, runner as any);
    const wi = await client.getWorkItem(42);
    const args = (runner.json as any).mock.calls[0][0] as string[];
    expect(args).toEqual([
      "boards",
      "work-item",
      "show",
      "--id",
      "42",
      "--expand",
      "fields",
      "--org",
      cfg.orgUrl
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

  it("createWorkItem shells az create with type, area, and mapped fields", async () => {
    const runner = makeRunner(() => ({
      id: 7,
      fields: { "System.Title": "Add SSO", "System.WorkItemType": "User Story" }
    }));
    const client = new AzBoardsClient(cfg as any, runner as any);
    const wi = await client.createWorkItem({
      type: "User Story",
      title: "Add SSO",
      description: "a\nb",
      areaPath: "IngOne\\Alpha",
      assignedTo: "jane@x.com",
      priority: "2",
      storyPoints: 5,
      tags: ["auth"]
    });
    const args = (runner.json as any).mock.calls[0][0] as string[];
    expect(args.slice(0, 3)).toEqual(["boards", "work-item", "create"]);
    expect(args).toContain("--type");
    expect(args).toContain("User Story");
    expect(args).toContain("--area");
    expect(args).toContain("IngOne\\Alpha");
    expect(args).toContain("--assigned-to");
    expect(args).toContain("jane@x.com");
    expect(args).toContain("--fields");
    expect(args).toContain("System.Description=a<br>b");
    expect(args).toContain("System.Tags=auth");
    expect(args).toContain("Microsoft.VSTS.Common.Priority=2");
    expect(args).toContain("Microsoft.VSTS.Scheduling.StoryPoints=5");
    expect(wi.id).toBe(7);
    expect(wi.workItemType).toBe("User Story");
  });

  it("getWorkItemFields shows the item and returns its fields", async () => {
    const runner = makeRunner(() => ({
      id: 5,
      fields: { "System.Title": "S", "System.WorkItemType": "User Story" }
    }));
    const f = await new AzBoardsClient(cfg as any, runner as any).getWorkItemFields(5);
    const args = (runner.json as any).mock.calls[0][0] as string[];
    expect(args).toEqual([
      "boards",
      "work-item",
      "show",
      "--id",
      "5",
      "--expand",
      "fields",
      "--org",
      cfg.orgUrl
    ]);
    expect(f).toEqual({ "System.Title": "S", "System.WorkItemType": "User Story" });
  });

  it("listChildren queries by parent and returns ids", async () => {
    const runner = makeRunner(() => [{ id: 11 }, { id: 12 }]);
    const ids = await new AzBoardsClient(cfg as any, runner as any).listChildren(9);
    const callArgs = (runner.json as any).mock.calls[0][0] as string[];
    const wiql = callArgs[callArgs.indexOf("--wiql") + 1];
    expect(wiql).toContain("[System.Parent] = 9");
    expect(ids).toEqual([11, 12]);
  });

  it("addRelation shells relation add with the relation type", async () => {
    const runner = makeRunner(() => ({}));
    await new AzBoardsClient(cfg as any, runner as any).addRelation(3, 2, "parent");
    const args = (runner.json as any).mock.calls[0][0] as string[];
    expect(args).toEqual([
      "boards",
      "work-item",
      "relation",
      "add",
      "--id",
      "3",
      "--relation-type",
      "parent",
      "--target-id",
      "2",
      "--org",
      cfg.orgUrl
    ]);
  });

  it("addRelation rejects a non-integer id without calling az", async () => {
    const runner = makeRunner(() => ({}));
    await expect(
      new AzBoardsClient(cfg as any, runner as any).addRelation(1.5, 2, "parent")
    ).rejects.toThrow(/integer/);
    expect((runner.json as any).mock.calls).toHaveLength(0);
  });
});
