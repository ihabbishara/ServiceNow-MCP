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
      url: "https://h/a", title: "A", hash: "h", crawledAt: 1, indexed: true,
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
