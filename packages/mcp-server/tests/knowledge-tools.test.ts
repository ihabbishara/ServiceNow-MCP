import { describe, it, expect, vi } from "vitest";
import { registerRegistryTools } from "../src/tools/registry.js";

/** Fake McpServer that captures `server.tool(name, desc, shape, handler)`. */
const fakeServer = () => {
  const handlers: Record<string, (args: any) => Promise<any>> = {};
  const server = {
    tool: (name: string, _d: string, _s: unknown, handler: (a: any) => Promise<any>) => {
      handlers[name] = handler;
    }
  } as any;
  return { server, handlers };
};

const rt = () =>
  ({
    knowledge: {
      search: vi.fn(async () => ({ count: 0, results: [] })),
      crawl: vi.fn(async () => ({
        pagesCrawled: 1,
        pagesIndexed: 1,
        pagesSkipped: 0,
        chunksAdded: 2,
        dropped: 0
      }))
    }
  }) as any;

describe("mcp knowledge tools", () => {
  it("registers search_knowledge + index_url", () => {
    const { server, handlers } = fakeServer();
    registerRegistryTools(server, rt());
    expect(Object.keys(handlers)).toEqual(
      expect.arrayContaining(["search_knowledge", "index_url"])
    );
  });

  it("search handler delegates to runtime and returns text content", async () => {
    const { server, handlers } = fakeServer();
    const runtime = rt();
    registerRegistryTools(server, runtime);
    const out = await handlers.search_knowledge({ query: "x" });
    expect(runtime.knowledge.search).toHaveBeenCalledWith("x", undefined, undefined);
    expect(out.content[0].type).toBe("text");
  });
});
