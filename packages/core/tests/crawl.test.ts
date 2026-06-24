import { describe, it, expect, vi } from "vitest";
import { crawl, type CrawlDeps } from "../src/services/knowledge/crawl.js";

// Fake link graph: seed -> /a (relevant) -> /b (relevant); /a also links offsite + /a again.
const pages: Record<string, { html: string }> = {
  "https://h/seed": { html: "seed" },
  "https://h/a": { html: "a" },
  "https://h/b": { html: "b" }
};

const makeDeps = (over: Partial<CrawlDeps> = {}): CrawlDeps => {
  const upserts: string[] = [];
  return {
    fetcher: { get: vi.fn(async (url: string) => ({ ok: !!pages[url], status: pages[url] ? 200 : 404, contentType: "text/html", body: pages[url]?.html ?? "" })) },
    extract: (_html: string, url: string) => ({
      title: url,
      mainText: `text of ${url}`,
      links: url === "https://h/seed" ? ["https://h/a", "https://other/x"] : url === "https://h/a" ? ["https://h/b", "https://h/a"] : []
    }),
    llm: {
      chat: vi.fn(async () => JSON.stringify({ relevant: true, keepLinks: ["https://h/a", "https://h/b", "https://other/x"] })),
      embed: vi.fn(async () => [1, 0, 0])
    },
    store: {
      getPageHash: vi.fn(() => undefined),
      upsertPage: vi.fn((p: any) => { upserts.push(p.url); }),
      stats: () => ({ pages: upserts.length, chunks: upserts.length })
    } as any,
    robots: { fetchAndCheck: vi.fn(async () => true) },
    now: () => 1,
    log: () => {},
    ...over
  };
};

describe("crawl", () => {
  it("stays within allowed domains and respects max pages", async () => {
    const deps = makeDeps();
    const res = await crawl(deps, {
      seeds: ["https://h/seed"], allowDomains: ["h"], maxPages: 10, maxDepth: 3,
      concurrency: 1, rateMs: 0, maxLinksPerPage: 50
    });
    const fetched = (deps.fetcher.get as any).mock.calls.map((c: any[]) => c[0]);
    expect(fetched).toContain("https://h/seed");
    expect(fetched).toContain("https://h/a");
    expect(fetched).toContain("https://h/b");
    expect(fetched).not.toContain("https://other/x"); // out of scope
    expect(res.pagesCrawled).toBe(3);
  });

  it("dedupes already-seen urls", async () => {
    const deps = makeDeps();
    await crawl(deps, { seeds: ["https://h/seed"], allowDomains: ["h"], maxPages: 10, maxDepth: 3, concurrency: 1, rateMs: 0, maxLinksPerPage: 50 });
    const fetched = (deps.fetcher.get as any).mock.calls.map((c: any[]) => c[0]);
    expect(fetched.filter((u: string) => u === "https://h/a")).toHaveLength(1);
  });

  it("skips re-embed when hash unchanged", async () => {
    const deps = makeDeps({
      store: {
        getPageHash: vi.fn(() => "SAME"),
        upsertPage: vi.fn(),
        stats: () => ({ pages: 0, chunks: 0 })
      } as any
    });
    // Force extract to a stable text so the hash matches what getPageHash returns.
    deps.extract = (_h, _u) => ({ title: "t", mainText: "SAME", links: [] });
    // hashOf is sha256; pre-seed store to return that exact hash:
    const { sha256 } = await import("../src/services/knowledge/crawl.js");
    (deps.store.getPageHash as any).mockReturnValue(sha256("SAME"));
    await crawl(deps, { seeds: ["https://h/seed"], allowDomains: ["h"], maxPages: 10, maxDepth: 0, concurrency: 1, rateMs: 0, maxLinksPerPage: 50 });
    expect(deps.store.upsertPage).not.toHaveBeenCalled();
  });

  it("respects maxDepth (depth 0 fetches only seeds)", async () => {
    const deps = makeDeps();
    await crawl(deps, { seeds: ["https://h/seed"], allowDomains: ["h"], maxPages: 10, maxDepth: 0, concurrency: 1, rateMs: 0, maxLinksPerPage: 50 });
    const fetched = (deps.fetcher.get as any).mock.calls.map((c: any[]) => c[0]);
    expect(fetched).toEqual(["https://h/seed"]);
  });
});
