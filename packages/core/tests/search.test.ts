import { describe, it, expect, vi } from "vitest";
import { search } from "../src/services/knowledge/search.js";

describe("search", () => {
  it("embeds the query and returns store hits", async () => {
    const embedder = { embed: vi.fn(async () => [1, 0, 0]) };
    const store = {
      knn: vi.fn(() => [
        { url: "https://h/a", title: "A", text: "full chunk body", snippet: "alpha", score: 0.9 }
      ])
    };
    const res = await search({ embedder, store } as any, "how to restart", 3);
    expect(embedder.embed).toHaveBeenCalledWith("how to restart");
    expect(store.knn).toHaveBeenCalledWith([1, 0, 0], 3, undefined);
    expect(res.count).toBe(1);
    expect(res.results[0].url).toBe("https://h/a");
    // Full chunk text must not leak into tool output — only the snippet does.
    expect(res.results[0]).not.toHaveProperty("text");
    expect(res.results[0].snippet).toBe("alpha");
    expect(res.results[0].score).toBe(0.9);
  });

  it("returns a hint when the index is empty", async () => {
    const embedder = { embed: vi.fn(async () => [1, 0, 0]) };
    const store = { knn: vi.fn(() => []) };
    const res = await search({ embedder, store } as any, "x", 3);
    expect(res.count).toBe(0);
    expect(res.hint).toMatch(/crawl/i);
  });
});
