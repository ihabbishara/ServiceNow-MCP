import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PROMPT_SPECS, promptSpec } from "@sre/core";
import type { McpRuntime } from "@sre/core";
import { registerPrompts } from "../src/prompts/index.js";

describe("registerPrompts parity", () => {
  it("registers every PROMPT_SPECS entry with its exact name, description, and schema", () => {
    const seen: Array<{ name: string; description: string; schema: unknown }> = [];
    const fakeServer = {
      prompt: (name: string, description: string, schema: unknown) => {
        seen.push({ name, description, schema });
      }
    };
    registerPrompts(fakeServer as unknown as McpServer, {} as McpRuntime);
    expect(seen).toEqual(
      PROMPT_SPECS.map((p) => ({ name: p.name, description: p.description, schema: p.schema }))
    );
  });
});

describe("prompt envelope over the wire", () => {
  const connect = async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerPrompts(server, {} as McpRuntime);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "c", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    return client;
  };

  it("incident_triage returns one user message whose text is the registry build output", async () => {
    const client = await connect();
    const res = await client.getPrompt({
      name: "incident_triage",
      arguments: { incident_number: "INC0012345" }
    });
    expect(res.messages).toHaveLength(1);
    expect(res.messages[0].role).toBe("user");
    expect(res.messages[0].content).toEqual({
      type: "text",
      text: promptSpec("incident_triage").build({ incident_number: "INC0012345" })
    });
  });

  it("shift_handover coerces hours_back from the string MCP transports it as", async () => {
    const client = await connect();
    const res = await client.getPrompt({
      name: "shift_handover",
      arguments: { team_name: "Platform SRE", hours_back: "12" }
    });
    const text = (res.messages[0].content as { type: "text"; text: string }).text;
    expect(text).toContain("for the Platform SRE team, covering the last 12 hours.");
  });
});
