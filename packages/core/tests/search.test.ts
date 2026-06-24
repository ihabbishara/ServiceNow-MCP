import { describe, it, expect, vi } from "vitest";
import { search } from "../src/services/knowledge/search.js";

describe("search", () => {
  it("embeds the query and returns store hits", async () => {
    const llm = { embed: vi.fn(async () => [1, 0, 0]), chat: vi.fn() };
    const store = { knn: vi.fn(() => [{ url: "https://h/a", title: "A", snippet: "alpha", score: 0.9 }]) };
    const res = await search({ llm, store } as any, "how to restart", 3);
    expect(llm.embed).toHaveBeenCalledWith("how to restart");
    expect(store.knn).toHaveBeenCalledWith([1, 0, 0], 3, undefined);
    expect(res.count).toBe(1);
    expect(res.results[0].url).toBe("https://h/a");
  });

  it("returns a hint when the index is empty", async () => {
    const llm = { embed: vi.fn(async () => [1, 0, 0]), chat: vi.fn() };
    const store = { knn: vi.fn(() => []) };
    const res = await search({ llm, store } as any, "x", 3);
    expect(res.count).toBe(0);
    expect(res.hint).toMatch(/crawl/i);
  });
});
