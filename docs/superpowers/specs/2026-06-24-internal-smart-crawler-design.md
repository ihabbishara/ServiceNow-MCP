# Internal Smart Crawler — Design

- **Date:** 2026-06-24
- **Status:** Approved (design); pending implementation plan
- **Scope:** Add an internal documentation crawler + semantic retrieval to the SRE agent.

## 1. Purpose

Spider a defined set of **internal documentation sites** and build a **persistent
semantic knowledge index** the agent queries during chat (RAG over internal docs:
runbooks, wikis, KB). Two facets combined:

- **Knowledge index / RAG** — periodic ingest into a searchable store.
- **Broad site spider** — seed URL(s) walked breadth-first within an allowed domain scope.

"Smart" is applied at **both ends**:
- **Crawl-time (LLM-guided):** a local model scores page relevance and prunes which
  links to follow, and the salient content is extracted.
- **Retrieval-time (semantic):** chunks are embedded with a local embedding model and
  retrieved by vector similarity.

## 2. Constraints & decisions

| Decision | Choice |
|----------|--------|
| Architecture | Pipeline in `@sre/core` + thin tool projections (Approach A) |
| Run model | **Both** — `crawl` CLI command (full/scheduled) + bounded in-agent `index_url` tool |
| Vector store | **SQLite + sqlite-vec** (embedded, single local file, no server) |
| Site auth | **Network-trusted / proxy only** — reuse `core/clients/proxy.ts`, no credentials |
| Models | Reuse the local **Ollama** endpoint validated for the agent: crawl-brain = chat model, embeddings = `nomic-embed-text` |
| MCP | Not used (org blocked MCP; standalone/offline ethos) |

**Rejected alternatives:** (B) agent-orchestrated crawl via primitives — cannot do
scheduled/CLI full-site ingest without re-implementing the loop, conflicts with the
"Both" requirement. (C) standalone crawler microservice via MCP — breaks
standalone/offline and the org blocks MCP.

## 3. Architecture & components

```
packages/core/src/
  clients/
    crawler/
      fetcher.ts      # undici GET via proxy.ts; content-type + size guards, rate limit
      extract.ts      # HTML -> {title, mainText, links[]}  (readability + linkedom)
      robots.ts       # robots.txt fetch + allow/deny check (toggle)
    llm.ts            # Ollama over undici: chat() + embed()  — OpenAI-compatible /v1
  services/
    knowledge/
      chunk.ts        # mainText -> chunks (heading/size aware)
      store.ts        # sqlite-vec: open/migrate/upsert/knn/stats
      crawl.ts        # LLM-guided BFS orchestrator (the "smart" core)
      search.ts       # query -> embed -> knn -> ranked chunks
  runtime.ts          # expose runtime.knowledge = { crawl, search, stats }

packages/sre-agent/src/
  cli/index.ts        # + `crawl` subcommand (full ingest)
  tools/index.ts      # + search_knowledge, index_url
packages/mcp-server/src/
  tools/knowledge.ts  # + same two tools (mcp surface parity)
```

**New dependencies (`@sre/core`):** `better-sqlite3` + `sqlite-vec` (embedded vector
store, native), `linkedom` + `@mozilla/readability` (clean content extraction).
`undici` already present. No server, no MCP.

**Unit interfaces (designed for isolation/testability):**
- `fetcher`: `url -> {status, contentType, body}` (+ guards). Pure I/O.
- `extract`: `html -> {title, mainText, links[]}`. Pure.
- `chunk`: `text -> chunks[]`. Pure.
- `llm`: `chat(prompt) -> text`, `embed(text) -> number[]`. I/O.
- `store`: vectors <-> disk (`upsert`, `knn`, `stats`). I/O over sqlite.
- `crawl`: the only stateful/complex unit; orchestrates the others. Tested with fakes.

### Data flow

- **CLI crawl:** env config → `crawl.ts` → loop[`fetcher` → `extract` → LLM relevance
  gate → `chunk` → `llm.embed` → `store.upsert`].
- **Agent query:** chat → `search_knowledge` tool → `search.ts` → `store.knn` → top-k
  chunks (url+title+snippet) → model answers with citations.
- **In-agent top-up:** `index_url` tool → same orchestrator, clamped small page cap.

**Two Ollama consumers, by design:** agent chat inference flows through the Copilot SDK
runtime (seat or Ollama-BYOK); the crawl pipeline calls Ollama **directly** over HTTP
(`core/clients/llm.ts`). CLI ingest runs entirely outside any Copilot session, so the
crawl path must not depend on the SDK. Shared endpoint config, separate transport.

## 4. Crawl pipeline (the "smart" core)

**Frontier:** BFS queue of `{url, depth}` seeded from `CRAWL_SEEDS`, scoped to
`CRAWL_ALLOW_DOMAINS`. URLs canonicalized (strip fragment, sort query params, lowercase
host) → dedup `Set`. Concurrency-bounded worker pool (`CRAWL_CONCURRENCY`, default 4),
polite per-host delay `CRAWL_RATE_MS`.

**Per-URL loop:**
1. `robots.ts` allow-check (skip if disallowed; toggle `CRAWL_RESPECT_ROBOTS`, default true).
2. `fetcher` GET → guards: `text/html` only, max body `CRAWL_MAX_BYTES` (default 2 MB),
   timeout. Non-HTML / errors → log + skip (never abort the run).
3. `extract` → `{title, mainText, links[]}`. Empty/boilerplate-only → skip indexing.
4. **Content hash** = sha256(mainText). If unchanged vs stored `pages.hash` → skip
   re-embed (incremental).
5. **LLM relevance + link-keep, single combined call** (`crawl.ts` → `llm.chat`):
   prompt = `CRAWL_TOPIC` + title + head(mainText) + capped outlink list (anchor text)
   → `{relevant: bool, keepLinks: string[]}`. One call/page (halves crawl LLM cost vs
   two separate calls).
6. If `relevant` → `chunk` → `llm.embed` each chunk → `store.upsert` (chunk text +
   vector + url/title/hash/crawled_at), within a per-page transaction.
7. Enqueue `keepLinks` (in-scope, not seen) if `depth < CRAWL_MAX_DEPTH` and pages
   crawled `< CRAWL_MAX_PAGES`. **Links are harvested even from pages that were skipped
   for indexing** (a boilerplate hub page can still lead to relevant content).

**Hard bounds (cost + safety):** `CRAWL_MAX_PAGES` (default 200), `CRAWL_MAX_DEPTH`
(default 3), max links scored per page (default 50). On hitting a cap, stop and **log
what was dropped** (no silent truncation).

**Incremental / resumable:** content-hash dedup means re-running `crawl` skips unchanged
pages and only re-embeds changed ones, driven by the per-URL `hash` + `crawled_at` in
the `pages` table.

## 5. Storage schema + retrieval

**File:** `KNOWLEDGE_DB_PATH` (default `~/.sre-agent/knowledge.db`). Opened by `store.ts`
via `better-sqlite3`; `sqlite-vec` extension loaded at open.

```sql
-- one row per indexed chunk
CREATE TABLE chunks (
  id INTEGER PRIMARY KEY,
  url        TEXT NOT NULL,
  title      TEXT,
  ord        INTEGER NOT NULL,        -- chunk position within page
  text       TEXT NOT NULL,
  crawled_at INTEGER NOT NULL
);
-- one row per crawled page (drives incremental re-crawl)
CREATE TABLE pages (
  url        TEXT PRIMARY KEY,
  hash       TEXT NOT NULL,           -- sha256 of mainText
  title      TEXT,
  crawled_at INTEGER NOT NULL,
  indexed    INTEGER NOT NULL         -- 1=embedded, 0=seen-but-skipped
);
-- sqlite-vec virtual table; rowid == chunks.id
CREATE VIRTUAL TABLE vec_chunks USING vec0(
  embedding float[768]                -- dim = embed model (nomic-embed-text = 768)
);
-- model/dim guard
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);  -- {embed_model, dim, ...}
```

**Embedding dim** is model-bound and pinned in `meta`. `store.ts` refuses to mix dims:
if `EMBED_MODEL` changed without a rebuild, it errors clearly rather than failing
silently.

**Upsert (per page):** delete old `chunks` + `vec_chunks` rows for the url → insert new
chunks/vectors → upsert `pages` row. Atomic transaction → re-crawl of a changed page is
a clean replace with no stale chunks.

**Retrieval (`search.ts`):** `embed(query)` → sqlite-vec KNN
(`WHERE embedding MATCH ? ORDER BY distance LIMIT k`) joined to `chunks` →
`[{url, title, snippet, score}]`. Default `k = 6`. Optional domain filter. **No reranker
in v1** (raw cosine); flagged as a later enhancement.

**`stats()`** → `{pages, chunks, lastCrawl, model, dim}` — powers a `doctor`/CLI status
line and lets the agent detect an empty index.

Rationale: `pages` (crawl state) is split from `chunks` (retrieval units) so the
incremental hash check hits the small `pages` table and only a changed hash triggers the
expensive embed+replace of that page's chunks.

## 6. Tools, CLI, config

**Agent/MCP tools** (projected in both `sre-agent/tools/index.ts` and
`mcp-server/tools/knowledge.ts`, from `runtime.knowledge`):

| Tool | Permission | Args | Returns |
|------|-----------|------|---------|
| `search_knowledge` | `skipPermission: true` (read) | `query`, `k?` (≤20), `domain?` | `{count, results:[{url,title,snippet,score}]}` |
| `index_url` | `skipPermission: true` (local-only write) | `url`, `depth?` (≤2), `max_pages?` (≤25) | `{pages_crawled, chunks_added, skipped}` |

Both follow the existing convention: handler `try/catch` → `{error: String(err)}`, never
throws. `index_url` is hard-clamped (small caps) so a chat turn cannot launch a 200-page
spider. Nothing **external** is mutated (only the local index), so `skipPermission: true`
is consistent with the existing 11 read tools; only `create_bug_from_incident` stays
gated.

**CLI** — new `crawl` subcommand in `sre-agent/src/cli/index.ts`, peer to `init`/`doctor`:

```
sre-agent crawl                 # full ingest from CRAWL_SEEDS (uses all bounds)
sre-agent crawl --seed <url>    # override seed(s)
sre-agent crawl --status        # print store.stats()
```

`doctor` gains checks: sqlite-vec loads, embed endpoint reachable, index stats. The
crawl path runs outside any Copilot session (no seat/BYOK auth needed).

**Config** (added to `sre-agent/src/config.ts` schema + `core/config.ts` passthrough,
same zod style):

| Env | Default | Notes |
|-----|---------|-------|
| `KNOWLEDGE_DB_PATH` | `~/.sre-agent/knowledge.db` | sqlite-vec file |
| `CRAWL_SEEDS` | — | comma list; required for `crawl` |
| `CRAWL_ALLOW_DOMAINS` | host(s) of seeds | crawl scope guard |
| `CRAWL_MAX_PAGES` | `200` | hard cap |
| `CRAWL_MAX_DEPTH` | `3` | |
| `CRAWL_CONCURRENCY` | `4` | |
| `CRAWL_RATE_MS` | `500` | per-host delay |
| `CRAWL_MAX_BYTES` | `2097152` | 2 MB body guard |
| `CRAWL_RESPECT_ROBOTS` | `true` | |
| `CRAWL_TOPIC` | — | optional relevance anchor for the LLM gate |
| `EMBED_MODEL` | `nomic-embed-text` | dim-pinned in store |
| `EMBED_BASE_URL` | = `LLM_BASE_URL` | reuse Ollama endpoint |
| `CRAWL_LLM_MODEL` | = `LLM_MODEL` | crawl-brain model |

`.env.example` + README get a knowledge/crawl block.

The `crawl` CLI and the `index_url` tool call the **same** `crawl.ts` orchestrator; the
only difference is the bounds object (CLI = full env bounds, tool = clamped small). One
engine, two callers.

## 7. Error handling

- **Per-URL failures** (timeout, non-HTML, 4xx/5xx, parse fail, oversized) → log + skip,
  continue. One bad page never aborts the run.
- **LLM/embed transient errors** → retry with backoff (3×). On persistent failure:
  relevance-gate failure → default **keep** the page (don't lose content); embed failure
  → record page `indexed = 0` + log so a later crawl retries. Crawl never half-writes a
  page (per-page transaction).
- **Setup failures, loud:** sqlite-vec extension won't load, embed endpoint unreachable,
  dim mismatch (model changed) → clear error from `store`/`doctor`, never a silent empty
  index.
- **Empty index on query:** `search_knowledge` returns
  `{count: 0, hint: "index empty — run `sre-agent crawl`"}`.
- **Tool handlers:** `try/catch` → `{error}`, matching the existing 12 tools.

## 8. Testing (vitest, mirroring `tests/` + fixtures pattern)

- `extract.test.ts` — fixture HTML → asserted `{title, mainText, links}`; boilerplate-stripping.
- `chunk.test.ts` — heading/size splitting; no chunk over max; no empty chunks.
- `store.test.ts` — in-memory sqlite-vec: upsert→knn roundtrip; re-upsert replaces chunks
  (no stale); dim-mismatch guard throws.
- `crawl.test.ts` — inject fake `fetcher` + fake `llm` + real in-memory `store`; assert
  frontier dedup, domain scoping, depth/page caps, skipped-page links still harvested,
  hash-unchanged skips re-embed, combined-call parsing.
- `search.test.ts` — query embed → ranked results, domain filter, empty-index hint.
- `robots.test.ts` — allow/deny parsing, toggle off.
- `config.test.ts` — new env defaults + validation (`crawl` requires seeds).
- Tool tests — `search_knowledge` / `index_url` projection + `{error}` on failure.

No live network or live Ollama in tests — all faked, matching how the engine tests fake
the Copilot client.

## 9. Out of scope (v1) / future

- Reranking of KNN results (raw cosine in v1).
- Authenticated sites (header/cookie/basic) — auth is network-trusted only for now;
  `fetcher` keeps a seam for adding it.
- Non-HTML ingest (PDF/Office docs).
- Scheduling — `crawl` is a CLI; external cron/pipeline can invoke it.
