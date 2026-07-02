import { createHash } from "node:crypto";
import type { Embedder, FetchResult, PageDoc } from "./types.js";
import type { ChatModel } from "../../clients/chat/types.js";
import type { KnowledgeStore } from "./store.js";
import { chunkText } from "./chunk.js";
import { buildVerdictPrompt, parseVerdict } from "./verdict.js";

export const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

export interface CrawlBounds {
  seeds: string[];
  allowDomains: string[];
  maxPages: number;
  maxDepth: number;
  concurrency: number;
  rateMs: number;
  maxLinksPerPage: number;
  topic?: string;
}

export interface CrawlDeps {
  fetcher: { get(url: string): Promise<FetchResult> };
  extract: (html: string, baseUrl: string) => PageDoc;
  embedder: Pick<Embedder, "embed">;
  /** Optional verdict chat. Absent (seat mode) → heuristic crawl. */
  chat?: ChatModel;
  store: Pick<KnowledgeStore, "getPageHash" | "upsertPage" | "stats">;
  robots: { fetchAndCheck(url: string): Promise<boolean> };
  now: () => number;
  log: (msg: string) => void;
}

export interface CrawlResult {
  pagesCrawled: number;
  pagesIndexed: number;
  pagesSkipped: number;
  chunksAdded: number; // total chunks embedded + upserted across all indexed pages
  dropped: number; // links not followed because a cap was hit
}

export const canonical = (url: string): string => {
  try {
    const u = new URL(url);
    u.hash = "";
    u.hostname = u.hostname.toLowerCase();
    u.searchParams.sort();
    return u.toString();
  } catch {
    return url;
  }
};

export const inScope = (url: string, allow: string[]): boolean => {
  try {
    return allow.includes(new URL(url).host);
  } catch {
    return false;
  }
};

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/** LLM-guided BFS crawl. Sequential by design (politeness); concurrency is a future add. */
export const crawl = async (deps: CrawlDeps, bounds: CrawlBounds): Promise<CrawlResult> => {
  const seen = new Set<string>();
  const queue: { url: string; depth: number }[] = [];
  for (const s of bounds.seeds) {
    const c = canonical(s);
    if (!inScope(c, bounds.allowDomains)) {
      deps.log(`[crawl] seed out of scope, skipped: ${c}`);
      continue;
    }
    if (!seen.has(c)) {
      seen.add(c);
      queue.push({ url: c, depth: 0 });
    }
  }

  const result: CrawlResult = {
    pagesCrawled: 0,
    pagesIndexed: 0,
    pagesSkipped: 0,
    chunksAdded: 0,
    dropped: 0
  };

  while (queue.length > 0) {
    if (result.pagesCrawled >= bounds.maxPages) {
      result.dropped += queue.length;
      deps.log(`[crawl] page cap ${bounds.maxPages} hit; dropping ${queue.length} queued URLs`);
      break;
    }
    const { url, depth } = queue.shift()!;

    if (!(await deps.robots.fetchAndCheck(url))) {
      deps.log(`[crawl] robots disallow ${url}`);
      continue;
    }

    const res = await deps.fetcher.get(url);
    if (!res.ok) {
      deps.log(`[crawl] skip ${url} (status ${res.status})`);
      continue;
    }
    result.pagesCrawled++;

    const doc = deps.extract(res.body, url);
    if (!doc.mainText) {
      result.pagesSkipped++;
      continue;
    }

    const hash = sha256(doc.mainText);
    const unchanged = deps.store.getPageHash(url) === hash;

    // Verdict: LLM (byok) when a chat model is present; otherwise heuristic
    // (seat mode) — index the page and follow all its links (scope/depth/cap
    // gates below still bound it).
    let verdict: { relevant: boolean; keepLinks: string[] };
    if (deps.chat) {
      const prompt = buildVerdictPrompt(
        bounds.topic,
        doc.title,
        doc.mainText.slice(0, 2000),
        doc.links,
        bounds.maxLinksPerPage
      );
      try {
        verdict = parseVerdict(await deps.chat.chat(prompt));
      } catch (e) {
        deps.log(`[crawl] verdict failed for ${url}; keeping page, no links: ${String(e)}`);
        verdict = { relevant: true, keepLinks: [] };
      }
    } else {
      verdict = { relevant: true, keepLinks: doc.links };
    }

    // Index (unless unchanged — incremental skip).
    if (verdict.relevant && !unchanged) {
      try {
        const chunks = chunkText(doc.mainText);
        const embedded = [];
        for (let i = 0; i < chunks.length; i++) {
          embedded.push({
            ord: i,
            text: chunks[i],
            embedding: await deps.embedder.embed(chunks[i])
          });
        }
        deps.store.upsertPage({
          url,
          title: doc.title,
          hash,
          crawledAt: deps.now(),
          indexed: true,
          chunks: embedded
        });
        result.pagesIndexed++;
        result.chunksAdded += embedded.length;
      } catch (e) {
        deps.log(`[crawl] embed/store failed for ${url}: ${String(e)}`);
        deps.store.upsertPage({
          url,
          title: doc.title,
          hash: "",
          crawledAt: deps.now(),
          indexed: false,
          chunks: []
        });
        result.pagesSkipped++;
      }
    } else {
      result.pagesSkipped++;
    }

    // Harvest links (even from skipped pages) for the frontier.
    if (depth < bounds.maxDepth) {
      for (const link of verdict.keepLinks) {
        const c = canonical(link);
        if (seen.has(c) || !inScope(c, bounds.allowDomains)) continue;
        if (result.pagesCrawled + queue.length >= bounds.maxPages) {
          result.dropped++;
          continue;
        }
        seen.add(c);
        queue.push({ url: c, depth: depth + 1 });
      }
    }

    await sleep(bounds.rateMs);
  }

  deps.log(`[crawl] done: ${JSON.stringify(result)}`);
  return result;
};
