import { describe, it, expect, vi } from "vitest";
import { runCrawl, bootCrawl } from "../src/cli/crawl.js";

const flush = () => new Promise((r) => setTimeout(r, 0));
const HOUR = 3_600_000;

describe("bootCrawl", () => {
  const makeRt = (lastCrawl?: number, missingSeeds: string[] = []) =>
    ({
      knowledge: {
        stats: vi.fn(async () => ({ pages: 1, chunks: 1, lastCrawl, model: "m", dim: 384 })),
        unindexedSeeds: vi.fn(async () => missingSeeds),
        crawl: vi.fn(async () => ({
          pagesCrawled: 1,
          pagesIndexed: 1,
          pagesSkipped: 0,
          chunksAdded: 1,
          dropped: 0
        }))
      }
    }) as any;

  it("does nothing when disabled (no seeds)", async () => {
    const rt = makeRt(Date.now());
    bootCrawl(rt, { enabled: false, ttlHours: 24 }, vi.fn());
    await flush();
    expect(rt.knowledge.stats).not.toHaveBeenCalled();
    expect(rt.knowledge.crawl).not.toHaveBeenCalled();
  });

  it("skips the crawl when the index is fresh and all seeds indexed", async () => {
    const rt = makeRt(Date.now() - 1 * HOUR, []); // 1h ago, ttl 24h, nothing missing
    bootCrawl(rt, { enabled: true, ttlHours: 24 }, vi.fn());
    await flush();
    expect(rt.knowledge.crawl).not.toHaveBeenCalled();
  });

  it("crawls when the index is stale (all seeds)", async () => {
    const rt = makeRt(Date.now() - 48 * HOUR); // 48h ago, ttl 24h
    bootCrawl(rt, { enabled: true, ttlHours: 24 }, vi.fn());
    await flush();
    expect(rt.knowledge.crawl).toHaveBeenCalledWith({}, expect.any(Function));
  });

  it("crawls when the index has never been crawled", async () => {
    const rt = makeRt(undefined);
    bootCrawl(rt, { enabled: true, ttlHours: 24 }, vi.fn());
    await flush();
    expect(rt.knowledge.crawl).toHaveBeenCalledWith({}, expect.any(Function));
  });

  it("ttlHours=0 always crawls, even right after a crawl", async () => {
    const rt = makeRt(Date.now());
    bootCrawl(rt, { enabled: true, ttlHours: 0 }, vi.fn());
    await flush();
    expect(rt.knowledge.crawl).toHaveBeenCalledWith({}, expect.any(Function));
  });

  it("fresh index but a new seed unindexed → crawls only the missing seed(s)", async () => {
    const rt = makeRt(Date.now() - 1 * HOUR, ["https://h/new"]); // fresh, 1 seed missing
    bootCrawl(rt, { enabled: true, ttlHours: 24 }, vi.fn());
    await flush();
    expect(rt.knowledge.crawl).toHaveBeenCalledWith(
      { seeds: ["https://h/new"] },
      expect.any(Function)
    );
  });
});

describe("runCrawl", () => {
  it("calls knowledge.crawl with seed overrides and prints a summary", async () => {
    const log = vi.fn();
    const rt = {
      knowledge: {
        crawl: vi.fn(async (_o: any, l: (m: string) => void) => {
          l("progress");
          return { pagesCrawled: 3, pagesIndexed: 2, pagesSkipped: 1, chunksAdded: 5, dropped: 0 };
        }),
        stats: () => ({ pages: 2, chunks: 5, model: "Xenova/bge-small-en-v1.5", dim: 384 }),
        close: vi.fn()
      }
    } as any;
    const code = await runCrawl(rt, ["--seed", "https://h/a"], log);
    expect(code).toBe(0);
    expect(rt.knowledge.crawl).toHaveBeenCalledWith(
      { seeds: ["https://h/a"] },
      expect.any(Function)
    );
  });

  it("--status prints stats without crawling", async () => {
    const rt = {
      knowledge: { crawl: vi.fn(), stats: () => ({ pages: 1, chunks: 2 }), close: vi.fn() }
    } as any;
    const code = await runCrawl(rt, ["--status"], vi.fn());
    expect(code).toBe(0);
    expect(rt.knowledge.crawl).not.toHaveBeenCalled();
  });
});
