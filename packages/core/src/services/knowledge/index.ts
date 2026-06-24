import type { KnowledgeConfig } from "../../config.js";
import { OllamaClient } from "../../clients/llm.js";
import { Fetcher } from "../../clients/crawler/fetcher.js";
import { extractPage } from "../../clients/crawler/extract.js";
import { RobotsClient } from "../../clients/crawler/robotsClient.js";
import { KnowledgeStore } from "./store.js";
import { crawl, type CrawlBounds, type CrawlResult } from "./crawl.js";
import { search, type SearchResponse } from "./search.js";
import type { KnowledgeStats } from "./types.js";

/** Embedding dimension by model. Extend as new embed models are supported. */
const EMBED_DIMS: Record<string, number> = {
  "nomic-embed-text": 768,
  "mxbai-embed-large": 1024,
  "all-minilm": 384
};

export interface CrawlOverrides {
  seeds?: string[];
  maxPages?: number;
  maxDepth?: number;
}

export class KnowledgeService {
  private readonly llm: OllamaClient;
  private readonly fetcher: Fetcher;
  private store?: KnowledgeStore;

  constructor(private readonly cfg: KnowledgeConfig) {
    this.llm = new OllamaClient({
      baseUrl: cfg.embedBaseUrl,
      chatModel: cfg.crawlModel,
      embedModel: cfg.embedModel,
      proxyUrl: cfg.proxyUrl
    });
    this.fetcher = new Fetcher({ maxBytes: cfg.maxBytes, proxyUrl: cfg.proxyUrl });
  }

  private getStore(): KnowledgeStore {
    if (!this.store) {
      const dim = EMBED_DIMS[this.cfg.embedModel];
      if (!dim) {
        throw new Error(
          `unknown embedding dim for model "${this.cfg.embedModel}". ` +
            `Add it to EMBED_DIMS in services/knowledge/index.ts.`
        );
      }
      this.store = new KnowledgeStore(this.cfg.dbPath, { model: this.cfg.embedModel, dim });
    }
    return this.store;
  }

  async crawl(overrides: CrawlOverrides = {}, log: (m: string) => void = () => {}): Promise<CrawlResult> {
    const bounds: CrawlBounds = {
      seeds: overrides.seeds ?? this.cfg.seeds,
      allowDomains: this.cfg.allowDomains,
      maxPages: overrides.maxPages ?? this.cfg.maxPages,
      maxDepth: overrides.maxDepth ?? this.cfg.maxDepth,
      concurrency: this.cfg.concurrency,
      rateMs: this.cfg.rateMs,
      maxLinksPerPage: 50,
      topic: this.cfg.topic
    };
    if (bounds.seeds.length === 0) throw new Error("no crawl seeds (set CRAWL_SEEDS or pass --seed)");
    const robots = new RobotsClient(this.fetcher, this.cfg.respectRobots);
    return crawl(
      { fetcher: this.fetcher, extract: extractPage, llm: this.llm, store: this.getStore(), robots, now: () => Date.now(), log },
      bounds
    );
  }

  async search(query: string, k?: number, domain?: string): Promise<SearchResponse> {
    return search({ llm: this.llm, store: this.getStore() }, query, k, domain);
  }

  stats(): KnowledgeStats {
    return this.getStore().stats();
  }

  close(): void {
    this.store?.close();
  }
}
