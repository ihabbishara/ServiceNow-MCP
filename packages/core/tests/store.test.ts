import { describe, it, expect } from "vitest";
import { KnowledgeStore } from "../src/services/knowledge/store.js";

const vec = (a: number, b: number, c: number) => [a, b, c];

describe("KnowledgeStore", () => {
  it("upserts a page + chunks and finds them by knn", () => {
    const s = new KnowledgeStore(":memory:", { model: "e", dim: 3 });
    s.upsertPage({
      url: "https://h/a",
      title: "A",
      hash: "h1",
      crawledAt: 1,
      indexed: true,
      chunks: [
        { ord: 0, text: "alpha", embedding: vec(1, 0, 0) },
        { ord: 1, text: "beta", embedding: vec(0, 1, 0) }
      ]
    });
    const hits = s.knn(vec(0.9, 0.1, 0), 1);
    expect(hits).toHaveLength(1);
    expect(hits[0].text).toBe("alpha");
    expect(hits[0].url).toBe("https://h/a");
    s.close();
  });

  it("re-upsert replaces a page's chunks (no stale rows)", () => {
    const s = new KnowledgeStore(":memory:", { model: "e", dim: 3 });
    const page = (text: string, emb: number[]) => ({
      url: "https://h/a",
      title: "A",
      hash: "h",
      crawledAt: 1,
      indexed: true,
      chunks: [{ ord: 0, text, embedding: emb }]
    });
    s.upsertPage(page("old", vec(1, 0, 0)));
    s.upsertPage(page("new", vec(1, 0, 0)));
    expect(s.stats().chunks).toBe(1);
    expect(s.knn(vec(1, 0, 0), 1)[0].text).toBe("new");
    s.close();
  });

  it("getPageHash returns the stored hash for incremental crawl", () => {
    const s = new KnowledgeStore(":memory:", { model: "e", dim: 3 });
    s.upsertPage({ url: "https://h/a", hash: "abc", crawledAt: 1, indexed: false, chunks: [] });
    expect(s.getPageHash("https://h/a")).toBe("abc");
    expect(s.getPageHash("https://h/missing")).toBeUndefined();
    s.close();
  });

  it("rejects a dim mismatch against the stored model", () => {
    const s = new KnowledgeStore(":memory:", { model: "e", dim: 3 });
    expect(() => s.knn([1, 2], 1)).toThrow(/dim/i);
    s.close();
  });
});

describe("KnowledgeStore listPages/deletePage", () => {
  const seed = (s: KnowledgeStore, url: string, n: number, at: number) =>
    s.upsertPage({
      url,
      title: url,
      hash: "h" + url,
      crawledAt: at,
      indexed: true,
      chunks: Array.from({ length: n }, (_, i) => ({
        ord: i,
        text: "t" + i,
        embedding: [0.1, 0.2, 0.3]
      }))
    });

  it("lists pages newest-first with chunk counts", () => {
    const s = new KnowledgeStore(":memory:", { model: "e", dim: 3 });
    seed(s, "upload://a.pdf", 2, 100);
    seed(s, "https://h/p", 3, 200);
    const rows = s.listPages();
    expect(rows.map((r) => r.url)).toEqual(["https://h/p", "upload://a.pdf"]);
    expect(rows[0]).toMatchObject({ chunkCount: 3, indexed: true });
    expect(rows[1].chunkCount).toBe(2);
    s.close();
  });

  it("deletePage removes the page, its chunks, AND its vec rows", () => {
    const s = new KnowledgeStore(":memory:", { model: "e", dim: 3 });
    seed(s, "upload://a.pdf", 2, 100);
    s.deletePage("upload://a.pdf");
    expect(s.listPages()).toEqual([]);
    expect(s.getPageHash("upload://a.pdf")).toBeUndefined();
    expect(s.stats().chunks).toBe(0);
    // vec rows gone too — a knn over the deleted embedding returns nothing.
    expect(s.knn([0.1, 0.2, 0.3], 5)).toEqual([]);
    s.close();
  });

  it("lastCrawl ignores uploads so document uploads don't poison the boot-crawl gate", () => {
    const s = new KnowledgeStore(":memory:", { model: "e", dim: 3 });
    seed(s, "https://h/p", 1, 100); // a web crawl at t=100
    seed(s, "upload://later.pdf", 1, 999); // an upload at t=999
    expect(s.stats().lastCrawl).toBe(100); // not 999
    s.close();
  });

  it("lastCrawl is undefined when only uploads exist", () => {
    const s = new KnowledgeStore(":memory:", { model: "e", dim: 3 });
    seed(s, "upload://only.pdf", 1, 500);
    expect(s.stats().lastCrawl).toBeUndefined();
    s.close();
  });
});
