import { describe, it, expect } from "vitest";
import { registerSharePointTools } from "./sharepoint.js";

type Handler = (...args: unknown[]) => unknown;
const fakeServer = () => {
  const tools: Record<string, Handler> = {};
  return {
    tool: (name: string, _d: string, _s: unknown, handler: Handler) => {
      tools[name] = handler;
    },
    tools
  };
};

describe("registerSharePointTools", () => {
  it("registers get_incident_documents that returns JSON text", async () => {
    const server = fakeServer();
    const runtime: any = {
      sharePoint: { getIncidentDocuments: async (n: string) => ({ incident: n, count: 0 }) }
    };
    registerSharePointTools(server as any, runtime);
    const out = await server.tools["get_incident_documents"]({ incident: "INC1" });
    expect(out.content[0].text).toContain('"incident": "INC1"');
  });

  it("returns an isError result when disabled", async () => {
    const server = fakeServer();
    registerSharePointTools(server as any, { sharePoint: undefined } as any);
    const out = await server.tools["get_incident_documents"]({ incident: "INC1" });
    expect(out.isError).toBe(true);
  });
});
