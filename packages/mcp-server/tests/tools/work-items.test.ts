import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerAdoTools } from "../../src/tools/ado.js";
import { registerWorkItemCsvTools } from "../../src/tools/workItemCsv.js";
import { McpRuntime } from "@sre/core";

const makeRuntime = (over: { enabled?: boolean; csvDir?: string; boardKnown?: boolean } = {}) => {
  const create = vi.fn().mockResolvedValue({
    id: 100,
    title: "T",
    state: "New",
    workItemType: "User Story",
    areaPath: "Platform\\Alpha"
  });
  const clone = vi
    .fn()
    .mockResolvedValue({ cloneId: 900, sourceId: 1, childrenCopied: 0, linked: false });
  const isBoardKnown = vi.fn().mockReturnValue(over.boardKnown ?? true);
  const runtime = {
    config: {
      azureDevOps: { enabled: over.enabled ?? true, csvDir: over.csvDir, csvMaxBytes: 1000000 },
      features: { createAdoBug: true }
    },
    workItemService: { create, clone, isBoardKnown },
    azureDevOpsClient: { searchWorkItems: vi.fn(), getWorkItem: vi.fn() },
    incidentService: { summarizeIncident: vi.fn() }
  } as unknown as McpRuntime;
  return { runtime, create, clone, isBoardKnown };
};

const connect = async (runtime: McpRuntime) => {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerAdoTools(server, runtime);
  registerWorkItemCsvTools(server, runtime);
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

describe("create_work_item tool", () => {
  it("is disabled when ADO is off", async () => {
    const { runtime } = makeRuntime({ enabled: false });
    const client = await connect(runtime);
    const r = await callJson(client, "create_work_item", { type: "Task", title: "x" });
    expect(r.isError).toBe(true);
  });

  it("maps snake_case args to the camelCase service input", async () => {
    const { runtime, create } = makeRuntime();
    const client = await connect(runtime);
    await callJson(client, "create_work_item", {
      type: "User Story",
      title: "SSO",
      description: "body",
      area_path: "P\\A",
      iteration_path: "P\\S1",
      tags: ["auth"],
      assigned_to: "jane@x.com",
      priority: "2",
      story_points: 5,
      parent_id: 42
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "User Story",
        title: "SSO",
        description: "body",
        areaPath: "P\\A",
        iterationPath: "P\\S1",
        tags: ["auth"],
        assignedTo: "jane@x.com",
        priority: "2",
        storyPoints: 5,
        parentId: 42
      })
    );
  });

  it("adds a boardWarning when the board name is unknown and no area_path given", async () => {
    const { runtime } = makeRuntime({ boardKnown: false });
    const client = await connect(runtime);
    const r = await callJson(client, "create_work_item", {
      type: "Task",
      title: "x",
      board: "Typo"
    });
    expect(JSON.parse(r.text).boardWarning).toMatch(/not found in ADO_BOARD_MAP/);
  });

  it("omits boardWarning for a known board", async () => {
    const { runtime } = makeRuntime({ boardKnown: true });
    const client = await connect(runtime);
    const r = await callJson(client, "create_work_item", {
      type: "Task",
      title: "x",
      board: "Team Alpha"
    });
    expect(JSON.parse(r.text).boardWarning).toBeUndefined();
  });
});

describe("clone_work_item tool", () => {
  it("maps overrides snake_case to camelCase service input", async () => {
    const { runtime, clone } = makeRuntime();
    const client = await connect(runtime);
    await callJson(client, "clone_work_item", {
      source_id: 1234,
      board: "Team Beta",
      include_children: true,
      link_to_source: true,
      title_prefix: "[C] ",
      overrides: { assigned_to: "bob@x.com", story_points: 3, priority: "1" }
    });
    expect(clone).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: 1234,
        board: "Team Beta",
        includeChildren: true,
        linkToSource: true,
        titlePrefix: "[C] ",
        overrides: expect.objectContaining({
          assignedTo: "bob@x.com",
          storyPoints: 3,
          priority: "1"
        })
      })
    );
  });

  it("is disabled when ADO is off", async () => {
    const { runtime } = makeRuntime({ enabled: false });
    const client = await connect(runtime);
    const r = await callJson(client, "clone_work_item", { source_id: 1 });
    expect(r.isError).toBe(true);
  });
});

describe("CSV tools", () => {
  it("list_work_item_csvs is disabled when csvDir is unset", async () => {
    const { runtime } = makeRuntime({ csvDir: undefined });
    const client = await connect(runtime);
    const r = await callJson(client, "list_work_item_csvs", {});
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/ADO_CSV_DIR/);
  });

  it("read_work_item_csv is disabled when csvDir is unset", async () => {
    const { runtime } = makeRuntime({ csvDir: undefined });
    const client = await connect(runtime);
    const r = await callJson(client, "read_work_item_csv", { filename: "x.csv" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/ADO_CSV_DIR/);
  });
});
