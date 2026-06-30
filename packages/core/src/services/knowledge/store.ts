import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import type { SearchHit, KnowledgeStats, SourceRow } from "./types.js";

export interface StoreMeta {
  model: string;
  dim: number;
}

export interface UpsertChunk {
  ord: number;
  text: string;
  embedding: number[];
}

export interface UpsertPage {
  url: string;
  title?: string;
  hash: string;
  crawledAt: number;
  indexed: boolean;
  chunks: UpsertChunk[];
}

const f32 = (v: number[]): Buffer => Buffer.from(new Float32Array(v).buffer);

export class KnowledgeStore {
  private readonly db: Database.Database;
  private readonly dim: number;
  private readonly model: string;

  constructor(path: string, meta: StoreMeta) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    sqliteVec.load(this.db);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY, url TEXT NOT NULL, title TEXT,
        ord INTEGER NOT NULL, text TEXT NOT NULL, crawled_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chunks_url ON chunks(url);
      CREATE TABLE IF NOT EXISTS pages (
        url TEXT PRIMARY KEY, hash TEXT NOT NULL, title TEXT,
        crawled_at INTEGER NOT NULL, indexed INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    `);
    // Pin / verify embedding dim.
    const existing = this.db.prepare("SELECT value FROM meta WHERE key = 'dim'").get() as { value: string } | undefined;
    if (existing) {
      const storedDim = Number(existing.value);
      if (storedDim !== meta.dim) {
        throw new Error(
          `embedding dim mismatch: store has ${storedDim}, config wants ${meta.dim}. ` +
            `Delete the index or revert EMBED_MODEL.`
        );
      }
      this.dim = storedDim;
      this.model = (this.db.prepare("SELECT value FROM meta WHERE key = 'model'").get() as { value: string }).value;
      if (this.model !== meta.model) {
        throw new Error(
          `embed model mismatch: store has ${this.model}, config wants ${meta.model}. ` +
            `Delete the index or revert EMBED_MODEL.`
        );
      }
    } else {
      this.dim = meta.dim;
      this.model = meta.model;
      this.db.prepare("INSERT INTO meta(key, value) VALUES ('dim', ?), ('model', ?)").run(String(meta.dim), meta.model);
    }
    this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(embedding float[${this.dim}]);`);
  }

  getPageHash(url: string): string | undefined {
    const row = this.db.prepare("SELECT hash FROM pages WHERE url = ?").get(url) as { hash: string } | undefined;
    return row?.hash;
  }

  upsertPage(page: UpsertPage): void {
    const tx = this.db.transaction((p: UpsertPage) => {
      const oldIds = this.db.prepare("SELECT id FROM chunks WHERE url = ?").all(p.url) as { id: number }[];
      const delVec = this.db.prepare("DELETE FROM vec_chunks WHERE rowid = ?");
      for (const { id } of oldIds) delVec.run(id);
      this.db.prepare("DELETE FROM chunks WHERE url = ?").run(p.url);

      const insChunk = this.db.prepare(
        "INSERT INTO chunks(url, title, ord, text, crawled_at) VALUES (?, ?, ?, ?, ?)"
      );
      const insVec = this.db.prepare("INSERT INTO vec_chunks(rowid, embedding) VALUES (?, ?)");
      for (const c of p.chunks) {
        if (c.embedding.length !== this.dim) throw new Error(`chunk dim ${c.embedding.length} != ${this.dim}`);
        const info = insChunk.run(p.url, p.title ?? null, c.ord, c.text, p.crawledAt);
        insVec.run(BigInt(info.lastInsertRowid as number), f32(c.embedding));
      }
      this.db
        .prepare(
          "INSERT INTO pages(url, hash, title, crawled_at, indexed) VALUES (?, ?, ?, ?, ?) " +
            "ON CONFLICT(url) DO UPDATE SET hash=excluded.hash, title=excluded.title, " +
            "crawled_at=excluded.crawled_at, indexed=excluded.indexed"
        )
        .run(p.url, p.hash, p.title ?? null, p.crawledAt, p.indexed ? 1 : 0);
    });
    tx(page);
  }

  knn(query: number[], k: number, domain?: string): (SearchHit & { text: string })[] {
    if (query.length !== this.dim) throw new Error(`query dim ${query.length} != stored dim ${this.dim}`);
    const rows = this.db
      .prepare(
        `SELECT c.url AS url, c.title AS title, c.text AS text, v.distance AS distance
         FROM vec_chunks v JOIN chunks c ON c.id = v.rowid
         WHERE v.embedding MATCH ? AND k = ?
         ORDER BY v.distance`
      )
      .all(f32(query), k) as { url: string; title: string | null; text: string; distance: number }[];
    return rows
      .filter((r) => !domain || (() => { try { return new URL(r.url).host === domain; } catch { return false; } })())
      .map((r) => ({
        url: r.url,
        title: r.title ?? undefined,
        text: r.text,
        snippet: r.text.slice(0, 400),
        score: 1 / (1 + r.distance)
      }));
  }

  stats(): KnowledgeStats {
    const pages = (this.db.prepare("SELECT COUNT(*) n FROM pages").get() as { n: number }).n;
    const chunks = (this.db.prepare("SELECT COUNT(*) n FROM chunks").get() as { n: number }).n;
    // lastCrawl reflects the last *web crawl*, not document uploads — otherwise an
    // upload would bump it and make the boot-crawl freshness gate skip the seed
    // re-crawl for a whole TTL window. Uploads are keyed `upload://…`.
    const last = this.db
      .prepare("SELECT MAX(crawled_at) m FROM pages WHERE url NOT LIKE 'upload://%'")
      .get() as { m: number | null };
    return { pages, chunks, lastCrawl: last.m ?? undefined, model: this.model, dim: this.dim };
  }

  listPages(): SourceRow[] {
    const rows = this.db
      .prepare(
        `SELECT p.url AS url, p.title AS title, p.crawled_at AS crawledAt, p.indexed AS indexed,
           (SELECT COUNT(*) FROM chunks c WHERE c.url = p.url) AS chunkCount
         FROM pages p ORDER BY p.crawled_at DESC`
      )
      .all() as { url: string; title: string | null; crawledAt: number; indexed: number; chunkCount: number }[];
    return rows.map((r) => ({
      url: r.url,
      title: r.title ?? undefined,
      crawledAt: r.crawledAt,
      indexed: !!r.indexed,
      chunkCount: r.chunkCount
    }));
  }

  deletePage(url: string): void {
    const tx = this.db.transaction((u: string) => {
      const ids = this.db.prepare("SELECT id FROM chunks WHERE url = ?").all(u) as { id: number }[];
      const delVec = this.db.prepare("DELETE FROM vec_chunks WHERE rowid = ?");
      for (const { id } of ids) delVec.run(id);
      this.db.prepare("DELETE FROM chunks WHERE url = ?").run(u);
      this.db.prepare("DELETE FROM pages WHERE url = ?").run(u);
    });
    tx(url);
  }

  close(): void {
    this.db.close();
  }
}
