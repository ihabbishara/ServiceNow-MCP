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
