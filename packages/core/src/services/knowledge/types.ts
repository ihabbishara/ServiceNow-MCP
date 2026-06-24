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

/** Minimal LLM surface the crawl/search code depends on. */
export interface LlmClient {
  chat(prompt: string): Promise<string>;
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
