import type { Embedder } from "./types.js";
import type { KnowledgeStore } from "./store.js";
import { chunkText } from "./chunk.js";
import { sha256 } from "./crawl.js";

export interface IngestDoc {
  key: string;
  title?: string;
  text: string;
}

export interface IngestResult {
  indexed: boolean;
  chunks: number;
  skipped?: string;
}

export type IngestPhase =
  | { phase: "embedding"; done: number; total: number }
  | { phase: "indexed"; chunks: number }
  | { phase: "skipped"; reason: string };

export interface IngestDeps {
  embedder: Pick<Embedder, "embed">;
  store: Pick<KnowledgeStore, "getPageHash" | "upsertPage">;
  now: () => number;
}

/** Index a single document's text: hash-dedup → chunk → embed → upsert. */
export const indexDocument = async (
  deps: IngestDeps,
  doc: IngestDoc,
  onPhase: (p: IngestPhase) => void = () => {}
): Promise<IngestResult> => {
  const text = doc.text.trim();
  if (!text) {
    onPhase({ phase: "skipped", reason: "no extractable text" });
    return { indexed: false, chunks: 0, skipped: "no extractable text" };
  }
  const hash = sha256(text);
  if (deps.store.getPageHash(doc.key) === hash) return { indexed: false, chunks: 0 };

  const chunks = chunkText(text);
  const embedded: { ord: number; text: string; embedding: number[] }[] = [];
  for (let i = 0; i < chunks.length; i++) {
    onPhase({ phase: "embedding", done: i, total: chunks.length });
    embedded.push({ ord: i, text: chunks[i], embedding: await deps.embedder.embed(chunks[i]) });
  }
  deps.store.upsertPage({
    url: doc.key,
    title: doc.title,
    hash,
    crawledAt: deps.now(),
    indexed: true,
    chunks: embedded
  });
  onPhase({ phase: "indexed", chunks: embedded.length });
  return { indexed: true, chunks: embedded.length };
};
