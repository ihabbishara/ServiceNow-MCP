import { describe, it, expect } from "vitest";
import { buildTools } from "./index.js";

// SHAPE NOTE: defineTool returns Tool<TArgs> with shape { name: string, handler?: ToolHandler }
// where ToolHandler = (args, invocation) => Promise<unknown>.
// The invocation (second arg) is unused by these handlers, so we pass {} as the second arg.
const toolByName = (runtime: any, name: string) =>
  buildTools(runtime).find((t: any) => t.name === name);

const call = (tool: any, args: unknown) => tool.handler!(args, {});

describe("get_incident_documents tool", () => {
  it("returns the service result", async () => {
    const runtime: any = {
      sharePoint: {
        getIncidentDocuments: async (n: string) => ({ incident: n, count: 0, documents: [] })
      }
    };
    const tool = toolByName(runtime, "get_incident_documents");
    const out = await call(tool, { incident: "INC123456" });
    expect(out).toMatchObject({ incident: "INC123456", count: 0 });
  });

  it("reports a clear error when SharePoint is disabled", async () => {
    const tool = toolByName({ sharePoint: undefined }, "get_incident_documents");
    const out = await call(tool, { incident: "INC1" });
    expect(out).toEqual({
      error: "SharePoint integration is disabled (set SHAREPOINT_ENABLED=true)."
    });
  });

  it("never throws — wraps service errors", async () => {
    const runtime: any = {
      sharePoint: {
        getIncidentDocuments: async () => {
          throw new Error("boom");
        }
      }
    };
    const tool = toolByName(runtime, "get_incident_documents");
    expect(await call(tool, { incident: "INC1" })).toEqual({ error: "Error: boom" });
  });
});
