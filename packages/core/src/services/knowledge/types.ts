/** Cleaned page content produced by the extractor. */
export interface PageDoc {
  title?: string;
  mainText: string;
  /** Absolute, resolved outbound links. */
  links: string[];
}

/** Result of fetching a URL. */
export interface FetchResult {
  ok: boolean;
  status: number;
  contentType: string;
  /** Decoded body text; empty when not ok or not HTML. */
  body: string;
}

/** Produces embedding vectors. The crawler's only vector source (local, in-process). */
export interface Embedder {
  readonly model: string;
  /** Embedding dimension; valid only after `ready()` (or first `embed`). */
  readonly dim: number;
  /** Loads the model so `dim` is known; idempotent. */
  ready(): Promise<void>;
  embed(text: string): Promise<number[]>;
}

/** Verdict returned by the combined relevance + link-keep LLM call. */
export interface CrawlVerdict {
  relevant: boolean;
  keepLinks: string[];
}

/** A retrieval hit. */
export interface SearchHit {
  url: string;
  title?: string;
  snippet: string;
  score: number;
}

/** Index summary. */
export interface KnowledgeStats {
  pages: number;
  chunks: number;
  lastCrawl?: number;
  model?: string;
  dim?: number;
}
