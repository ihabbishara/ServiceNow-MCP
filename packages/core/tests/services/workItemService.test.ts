import { describe, it, expect, vi } from "vitest";
import { WorkItemService } from "../../src/services/workItemService.js";

const makeClient = (over: Partial<Record<string, any>> = {}) => ({
  createWorkItem: vi.fn(async (p: any) => ({ id: 100, title: p.title, state: "New", workItemType: p.type, areaPath: p.areaPath })),
  addRelation: vi.fn(async () => {}),
  getWorkItemFields: vi.fn(async () => null),
  listChildren: vi.fn(async () => []),
  searchWorkItems: vi.fn(),
  getWorkItem: vi.fn(),
  createBug: vi.fn(),
  ...over
});

const cfg = { boardMap: { "Team Alpha": "Platform\\Alpha" }, defaultAreaPath: "Platform", defaultIterationPath: "Platform\\S1" };

describe("WorkItemService.resolveAreaPath", () => {
  it("prefers explicit areaPath over board and default", () => {
    const svc = new WorkItemService(makeClient() as any, cfg);
    expect(svc.resolveAreaPath("Team Alpha", "Explicit\\Path")).toBe("Explicit\\Path");
  });
  it("maps a known board name", () => {
    const svc = new WorkItemService(makeClient() as any, cfg);
    expect(svc.resolveAreaPath("Team Alpha")).toBe("Platform\\Alpha");
  });
  it("falls back to defaultAreaPath for an unknown board", () => {
    const svc = new WorkItemService(makeClient() as any, cfg);
    expect(svc.resolveAreaPath("Nope")).toBe("Platform");
  });
});

describe("WorkItemService.create", () => {
  it("creates with the resolved area path", async () => {
    const client = makeClient();
    const svc = new WorkItemService(client as any, cfg);
    await svc.create({ type: "User Story", title: "S", board: "Team Alpha" });
    expect(client.createWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({ type: "User Story", title: "S", areaPath: "Platform\\Alpha", iterationPath: "Platform\\S1" })
    );
  });

  it("links the new item to a parent when parentId is set", async () => {
    const client = makeClient({ createWorkItem: vi.fn(async () => ({ id: 200, title: "T", state: "New" })) });
    const svc = new WorkItemService(client as any, cfg);
    await svc.create({ type: "Task", title: "T", parentId: 42 });
    expect(client.addRelation).toHaveBeenCalledWith(200, 42, "parent");
  });

  it("does not link when parentId is absent", async () => {
    const client = makeClient();
    const svc = new WorkItemService(client as any, cfg);
    await svc.create({ type: "Task", title: "T" });
    expect(client.addRelation).not.toHaveBeenCalled();
  });
});

const sourceFields = {
  "System.Title": "Add SSO",
  "System.WorkItemType": "User Story",
  "System.Description": "Body <br> here",
  "System.Tags": "auth; security",
  "Microsoft.VSTS.Common.Priority": 2,
  "Microsoft.VSTS.Scheduling.StoryPoints": 5,
  "System.State": "Active",
  "System.AssignedTo": { uniqueName: "orig@x.com" }
};

describe("WorkItemService.clone", () => {
  it("clones fields to the target board, resets state/assignee", async () => {
    const client = makeClient({
      getWorkItemFields: vi.fn(async () => sourceFields),
      createWorkItem: vi.fn(async (p: any) => ({ id: 900, title: p.title, state: "New" }))
    });
    const svc = new WorkItemService(client as any, cfg);
    const res = await svc.clone({ sourceId: 1234, board: "Team Alpha" });

    const payload = (client.createWorkItem as any).mock.calls[0][0];
    expect(payload.type).toBe("User Story");
    expect(payload.title).toBe("Add SSO");
    expect(payload.areaPath).toBe("Platform\\Alpha");
    expect(payload.tags).toEqual(["auth", "security"]);
    expect(payload.priority).toBe("2");
    expect(payload.storyPoints).toBe(5);
    expect(payload.assignedTo).toBeUndefined(); // cleared
    expect(payload.fields["System.Description"]).toBe("Body <br> here"); // raw, no re-conversion
    expect(res).toEqual({ cloneId: 900, sourceId: 1234, childrenCopied: 0, linked: false });
  });

  it("applies a title prefix and overrides", async () => {
    const client = makeClient({ getWorkItemFields: vi.fn(async () => sourceFields) });
    const svc = new WorkItemService(client as any, cfg);
    await svc.clone({ sourceId: 1, board: "Team Alpha", titlePrefix: "[CLONE] ", overrides: { priority: "1", tags: ["x"] } });
    const payload = (client.createWorkItem as any).mock.calls[0][0];
    expect(payload.title).toBe("[CLONE] Add SSO");
    expect(payload.priority).toBe("1");
    expect(payload.tags).toEqual(["x"]);
  });

  it("copies children and links them to the clone when includeChildren is set", async () => {
    const childFields = { "System.Title": "Subtask", "System.WorkItemType": "Task", "System.Description": "do it" };
    const client = makeClient({
      getWorkItemFields: vi.fn(async (id: number) => (id === 1 ? sourceFields : childFields)),
      listChildren: vi.fn(async () => [55]),
      createWorkItem: vi.fn(async (p: any) => ({ id: p.type === "Task" ? 901 : 900, title: p.title, state: "New" }))
    });
    const svc = new WorkItemService(client as any, cfg);
    const res = await svc.clone({ sourceId: 1, board: "Team Alpha", includeChildren: true });
    expect(client.listChildren).toHaveBeenCalledWith(1);
    expect(client.addRelation).toHaveBeenCalledWith(901, 900, "parent"); // child linked under clone
    expect(res.childrenCopied).toBe(1);
  });

  it("adds a related link back to the source when linkToSource is set", async () => {
    const client = makeClient({
      getWorkItemFields: vi.fn(async () => sourceFields),
      createWorkItem: vi.fn(async () => ({ id: 900, title: "Add SSO", state: "New" }))
    });
    const svc = new WorkItemService(client as any, cfg);
    const res = await svc.clone({ sourceId: 1234, board: "Team Alpha", linkToSource: true });
    expect(client.addRelation).toHaveBeenCalledWith(900, 1234, "related");
    expect(res.linked).toBe(true);
  });

  it("throws when the source is not found", async () => {
    const client = makeClient({ getWorkItemFields: vi.fn(async () => null) });
    const svc = new WorkItemService(client as any, cfg);
    await expect(svc.clone({ sourceId: 999 })).rejects.toThrow(/999.*not found/);
  });
});
