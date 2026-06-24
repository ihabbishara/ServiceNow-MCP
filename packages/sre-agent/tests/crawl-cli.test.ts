import { describe, it, expect, vi } from "vitest";
import { runCrawl } from "../src/cli/crawl.js";

describe("runCrawl", () => {
  it("calls knowledge.crawl with seed overrides and prints a summary", async () => {
    const log = vi.fn();
    const rt = {
      knowledge: {
        crawl: vi.fn(async (_o: any, l: (m: string) => void) => { l("progress"); return { pagesCrawled: 3, pagesIndexed: 2, pagesSkipped: 1, dropped: 0 }; }),
        stats: () => ({ pages: 2, chunks: 5, model: "nomic-embed-text", dim: 768 }),
        close: vi.fn()
      }
    } as any;
    const code = await runCrawl(rt, ["--seed", "https://h/a"], log);
    expect(code).toBe(0);
    expect(rt.knowledge.crawl).toHaveBeenCalledWith({ seeds: ["https://h/a"] }, expect.any(Function));
  });

  it("--status prints stats without crawling", async () => {
    const rt = { knowledge: { crawl: vi.fn(), stats: () => ({ pages: 1, chunks: 2 }), close: vi.fn() } } as any;
    const code = await runCrawl(rt, ["--status"], vi.fn());
    expect(code).toBe(0);
    expect(rt.knowledge.crawl).not.toHaveBeenCalled();
  });
});
