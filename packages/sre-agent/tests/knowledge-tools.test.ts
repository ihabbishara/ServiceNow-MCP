import { describe, it, expect, vi } from "vitest";
import { buildTools } from "../src/tools/index.js";

const fakeRuntime = () =>
  ({
    knowledge: {
      search: vi.fn(async () => ({ count: 1, results: [{ url: "https://h/a", title: "A", snippet: "x", score: 0.9 }] })),
      crawl: vi.fn(async () => ({ pagesCrawled: 2, pagesIndexed: 1, pagesSkipped: 1, chunksAdded: 3, dropped: 0 })),
      stats: () => ({ pages: 0, chunks: 0 })
    }
  }) as any;

const find = (rt: any, name: string) => buildTools(rt).find((t: any) => t.name === name);

describe("knowledge tools", () => {
  it("registers search_knowledge and index_url", () => {
    const rt = fakeRuntime();
    expect(find(rt, "search_knowledge")).toBeTruthy();
    expect(find(rt, "index_url")).toBeTruthy();
  });

  it("search_knowledge returns store results", async () => {
    const rt = fakeRuntime();
    const out = await find(rt, "search_knowledge").handler({ query: "restart" });
    expect(out.count).toBe(1);
    expect(rt.knowledge.search).toHaveBeenCalledWith("restart", undefined, undefined);
  });

  it("index_url clamps depth/max_pages and calls crawl", async () => {
    const rt = fakeRuntime();
    await find(rt, "index_url").handler({ url: "https://h/a", depth: 99, max_pages: 999 });
    expect(rt.knowledge.crawl).toHaveBeenCalledWith(
      { seeds: ["https://h/a"], maxDepth: 2, maxPages: 25 },
      expect.any(Function)
    );
  });

  it("returns {error} when the service throws", async () => {
    const rt = fakeRuntime();
    rt.knowledge.search.mockRejectedValueOnce(new Error("boom"));
    const out = await find(rt, "search_knowledge").handler({ query: "x" });
    expect(out.error).toContain("boom");
  });
});
