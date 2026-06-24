import { describe, it, expect } from "vitest";
import { chunkText } from "../src/services/knowledge/chunk.js";

describe("chunkText", () => {
  it("returns one chunk for short text", () => {
    expect(chunkText("hello world", 100, 10)).toEqual(["hello world"]);
  });

  it("splits long text with overlap and never exceeds size", () => {
    const text = "a".repeat(250);
    const chunks = chunkText(text, 100, 20);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100);
  });

  it("drops empty/whitespace-only input", () => {
    expect(chunkText("   \n  ", 100, 10)).toEqual([]);
  });
});
