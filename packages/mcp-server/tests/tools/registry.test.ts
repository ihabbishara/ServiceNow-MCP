import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TOOL_SPECS, McpRuntime } from "@sre/core";
import { registerRegistryTools } from "../../src/tools/registry.js";

describe("registerRegistryTools parity", () => {
  it("registers every registry spec with its exact name, description, and schema", () => {
    const seen: Array<{ name: string; description: string; schema: unknown }> = [];
    const fakeServer = {
      tool: (name: string, description: string, schema: unknown) => {
        seen.push({ name, description, schema });
      }
    };
    registerRegistryTools(fakeServer as unknown as McpServer, {} as McpRuntime);
    expect(seen).toEqual(
      TOOL_SPECS.map((s) => ({ name: s.name, description: s.description, schema: s.schema }))
    );
  });
});

describe("toMcpHandler result shaping", () => {
  const runtime = (over: Record<string, unknown> = {}) =>
    ({
      config: {},
      serviceNowClient: {
        getIncidentByNumber: vi.fn(async () => null),
        listIncidentsWithFilters: vi.fn(async () => [])
      },
      ...over
    }) as unknown as McpRuntime;

  const connect = async (rt: McpRuntime) => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerRegistryTools(server, rt);
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

  it("wraps success as pretty JSON text", async () => {
    const rt = runtime({
      serviceNowClient: {
        getIncidentByNumber: vi.fn(async () => ({ number: "INC9" })),
        listIncidentsWithFilters: vi.fn(async () => [])
      }
    });
    const client = await connect(rt);
    const r = await callJson(client, "get_incident", { number: "INC9" });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text)).toEqual({ number: "INC9" });
  });

  it("surfaces ToolError messages verbatim with isError", async () => {
    const client = await connect(runtime());
    const r = await callJson(client, "get_incident", { number: "INC0" });
    expect(r.isError).toBe(true);
    expect(r.text).toBe("Incident INC0 not found");
  });

  it("formats unexpected errors as 'Error: <message>'", async () => {
    const rt = runtime({
      serviceNowClient: {
        getIncidentByNumber: vi.fn(async () => {
          throw new Error("boom");
        }),
        listIncidentsWithFilters: vi.fn(async () => [])
      }
    });
    const client = await connect(rt);
    const r = await callJson(client, "get_incident", { number: "INC1" });
    expect(r.isError).toBe(true);
    expect(r.text).toBe("Error: boom");
  });
});
