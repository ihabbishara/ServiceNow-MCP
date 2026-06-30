import { describe, it, expect, vi } from "vitest";
import { indexDocument } from "../src/services/knowledge/ingest.js";

const fakeEmbedder = { embed: vi.fn(async () => [0.1, 0.2, 0.3]) };
const makeStore = (existingHash?: string) => ({
  getPageHash: vi.fn(() => existingHash),
  upsertPage: vi.fn()
});

describe("indexDocument", () => {
  it("chunks, embeds, and upserts a document", async () => {
    const store = makeStore();
    const onPhase = vi.fn();
    const res = await indexDocument(
      { embedder: fakeEmbedder, store, now: () => 1234 },
      { key: "upload://a.txt", title: "a.txt", text: "hello world" },
      onPhase
    );
    expect(res).toEqual({ indexed: true, chunks: 1 });
    expect(store.upsertPage).toHaveBeenCalledWith(
      expect.objectContaining({ url: "upload://a.txt", title: "a.txt", indexed: true, crawledAt: 1234 })
    );
    expect(onPhase).toHaveBeenCalledWith({ phase: "indexed", chunks: 1 });
  });

  it("skips an unchanged document by content hash", async () => {
    // hash of "hello" must match what indexDocument computes — reuse its own sha256
    const { sha256 } = await import("../src/services/knowledge/crawl.js");
    const store = makeStore(sha256("hello"));
    const res = await indexDocument(
      { embedder: fakeEmbedder, store, now: () => 1 },
      { key: "upload://a.txt", text: "hello" }
    );
    expect(res).toEqual({ indexed: false, chunks: 0 });
    expect(store.upsertPage).not.toHaveBeenCalled();
  });

  it("skips empty text", async () => {
    const store = makeStore();
    const res = await indexDocument(
      { embedder: fakeEmbedder, store, now: () => 1 },
      { key: "upload://blank.txt", text: "   " }
    );
    expect(res).toEqual({ indexed: false, chunks: 0, skipped: "no extractable text" });
    expect(store.upsertPage).not.toHaveBeenCalled();
  });
});
