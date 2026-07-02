import { describe, it, expect } from "vitest";
import { registerRegistryTools } from "../../src/tools/registry.js";

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

describe("get_incident_documents via registry", () => {
  it("registers get_incident_documents that returns JSON text", async () => {
    const server = fakeServer();
    const runtime: any = {
      config: { sharePoint: { enabled: true } },
      sharePoint: { getIncidentDocuments: async (n: string) => ({ incident: n, count: 0 }) }
    };
    registerRegistryTools(server as any, runtime);
    const out = (await server.tools["get_incident_documents"]({ incident: "INC1" })) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(out.content[0].text).toContain('"incident": "INC1"');
  });

  it("returns an isError result when disabled", async () => {
    const server = fakeServer();
    const runtime: any = {
      config: { sharePoint: { enabled: false } },
      sharePoint: undefined
    };
    registerRegistryTools(server as any, runtime);
    const out = (await server.tools["get_incident_documents"]({ incident: "INC1" })) as {
      content: Array<{ type: string; text: string }>;
      isError: boolean;
    };
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toBe(
      "SharePoint integration is disabled (set SHAREPOINT_ENABLED=true)."
    );
  });
});
