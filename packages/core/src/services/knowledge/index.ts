import type { KnowledgeConfig } from "../../config.js";
import { LocalEmbedder } from "../../clients/embedder.js";
import { makeChatModel } from "../../clients/chat/factory.js";
import type { ChatModel } from "../../clients/chat/types.js";
import { Fetcher } from "../../clients/crawler/fetcher.js";
import { extractPage } from "../../clients/crawler/extract.js";
import { RobotsClient } from "../../clients/crawler/robotsClient.js";
import { KnowledgeStore } from "./store.js";
import { crawl, canonical, inScope, type CrawlBounds, type CrawlResult } from "./crawl.js";
import { search, type SearchResponse } from "./search.js";
import type { KnowledgeStats, SourceRow } from "./types.js";
import { indexDocument as runIndexDocument, type IngestDoc, type IngestPhase, type IngestResult } from "./ingest.js";

export interface CrawlOverrides {
  seeds?: string[];
  maxPages?: number;
  maxDepth?: number;
}

export class KnowledgeService {
  private readonly embedder: LocalEmbedder;
  private readonly chat?: ChatModel;
  private readonly fetcher: Fetcher;
  private store?: KnowledgeStore;

  constructor(private readonly cfg: KnowledgeConfig) {
    this.embedder = new LocalEmbedder(cfg.embedModel, cfg.embedModelPath);
    this.chat = makeChatModel(cfg.chat, cfg.proxyUrl);
    this.fetcher = new Fetcher({ maxBytes: cfg.maxBytes, proxyUrl: cfg.proxyUrl });
  }

  /** Load the embed model (so dim is known) then open the store keyed on {model, dim}. */
  private async ensureStore(): Promise<KnowledgeStore> {
    if (!this.store) {
      await this.embedder.ready();
      this.store = new KnowledgeStore(this.cfg.dbPath, { model: this.embedder.model, dim: this.embedder.dim });
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
    const store = await this.ensureStore();
    const robots = new RobotsClient(this.fetcher, this.cfg.respectRobots);
    return crawl(
      {
        fetcher: this.fetcher,
        extract: extractPage,
        embedder: this.embedder,
        chat: this.chat,
        store,
        robots,
        now: () => Date.now(),
        log
      },
      bounds
    );
  }

  /**
   * Configured seeds (in-scope) that have no page row yet — i.e. never crawled.
   * Lets the boot gate index a freshly-added seed even when the index as a whole
   * is still "fresh" by TTL (lastCrawl is a global MAX, blind to per-seed gaps).
   */
  async unindexedSeeds(): Promise<string[]> {
    const store = await this.ensureStore();
    return this.cfg.seeds
      .map(canonical)
      .filter((c) => inScope(c, this.cfg.allowDomains) && store.getPageHash(c) === undefined);
  }

  async search(query: string, k?: number, domain?: string): Promise<SearchResponse> {
    const store = await this.ensureStore();
    return search({ embedder: this.embedder, store }, query, k, domain);
  }

  async stats(): Promise<KnowledgeStats> {
    const store = await this.ensureStore();
    return store.stats();
  }

  async indexDocument(doc: IngestDoc, onPhase?: (p: IngestPhase) => void): Promise<IngestResult> {
    const store = await this.ensureStore();
    return runIndexDocument({ embedder: this.embedder, store, now: () => Date.now() }, doc, onPhase);
  }

  async listSources(): Promise<SourceRow[]> {
    const store = await this.ensureStore();
    return store.listPages();
  }

  async deleteSource(key: string): Promise<void> {
    const store = await this.ensureStore();
    store.deletePage(key);
  }

  async close(): Promise<void> {
    this.store?.close();
    this.store = undefined;
    await this.embedder.dispose();
  }
}

export type { IngestDoc, IngestPhase, IngestResult } from "./ingest.js";
