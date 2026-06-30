# UI Document & URL Ingest — Design

Date: 2026-06-30
Status: Approved (design), pending implementation plan

## Problem

The knowledge index is populated only by the crawler (CLI `crawl`, boot crawl,
or the `index_url` agent tool). Users have no way, from the web UI, to add a
source on demand — neither a local document (PDF, CSV, XLSX, PPTX, DOCX, TXT)
nor an ad-hoc URL. We want a UI affordance to drag-and-drop documents and paste
a URL, have them parsed, chunked, embedded, and indexed, with live progress.

## Goal

A dedicated **Sources** panel in the web UI where a user can:
- Drag-and-drop (or browse to) one or more documents to index.
- Paste a URL to crawl-and-index.
- See a live-updating list of ingested sources with per-source status.
- Delete a source from the index.

## Non-goals (v1 / YAGNI)

- Folder or `.zip` upload.
- OCR for scanned/image-only PDFs.
- Per-source re-crawl scheduling.
- Multi-user permissions or sharing.
- Legacy binary Office formats (`.ppt`, `.xls`) — rejected with a clear message.

## What already exists (reused, not rebuilt)

| Capability | Symbol | Location |
|---|---|---|
| Parse PDF/DOCX/XLSX/PPTX → text | `defaultParsers`, `extractText(name, bytes, parsers)`, `formatOf` | `core/src/clients/sharepoint/{parsers,extract}.ts` |
| Chunk text | `chunkText(text, size?, overlap?)` | `core/src/services/knowledge/chunk.ts` |
| Embed (local ONNX) | `LocalEmbedder.embed()` | `core/src/clients/embedder.ts` |
| Store + content-hash dedup | `KnowledgeStore.upsertPage()` (PK `url`), `getPageHash()` | `core/src/services/knowledge/store.ts` |
| Search by url | `search()` | `core/src/services/knowledge/search.ts` |
| Add-a-URL / crawl | `KnowledgeService.crawl({ seeds:[url] })` | `core/src/services/knowledge/{index,crawl}.ts` |
| SSE broadcast hub | `SseHub`, `EngineHost.emit()` | `web/server/{sse,engine-host}.ts` |
| Single SSE stream → reducer | `useServerStream`, `applyServerEvent` | `web/client/src/{sse.ts,state.ts}` |

Parser deps (`pdf-parse`, `mammoth`, `officeparser`) are already vendored in
`core/package.json`. **No new dependency is introduced.**

The text-extraction layer was written for SharePoint but is format-generic
(filename → format → parser); it is lifted into a shared namespace so uploads
and SharePoint both use it. Two ingest shapes exist today — **crawl** (URL →
fetch → extract → index) and SharePoint **read-inline** (file → extract → hand
to agent, *not* indexed). This feature adds the missing third shape: **file →
extract → index**, which is crawl's inner loop minus the fetch.

## Architecture

Three layers.

### 1. core — generalize parsing + add an index-a-document path

- **Relocate doc parsing** from `clients/sharepoint/{extract,parsers}.ts` into a
  shared `clients/docparse/` module (`extractText`, `formatOf`, `extOf`,
  `defaultParsers`, `DocFormat`). SharePoint imports from the new location
  (behavior unchanged). Add `csv` and `txt` formats (`buffer.toString("utf8")`).
  - `EXT_TO_FORMAT` grows: `csv → csv`, `txt → txt`.
  - Legacy `.ppt`/`.xls`/etc. remain unmapped → `formatOf` returns `null` →
    `extractText` returns `{ skipped: "unsupported format: .ppt" }`.

- **`KnowledgeService.indexDocument(doc, onPhase?)`** — new method. Mirrors
  `crawl.ts:111-126` minus fetch/links:
  ```
  indexDocument(
    doc: { key: string; title?: string; text: string },
    onPhase?: (p: IngestPhase) => void
  ): Promise<{ indexed: boolean; chunks: number; skipped?: string }>
  ```
  Steps: `ensureStore()` → `hash = sha256(doc.text)` → if
  `getPageHash(doc.key) === hash` return `{ indexed:false, chunks:0 }`
  (unchanged) → `chunkText(doc.text)` → embed each chunk (emit
  `embedding i/M` via `onPhase`) → `upsertPage({ url: doc.key, title, hash,
  crawledAt: now, indexed:true, chunks })`. Empty text → `{ indexed:false,
  skipped:"no extractable text" }`.
  - `key` for an uploaded file = `upload://<filename>`. Re-upload of the same
    filename replaces its chunks (upsert); identical content is hash-skipped.

- **`KnowledgeService.listSources()`** + **`KnowledgeStore.listPages()`** →
  `{ url, title?, crawledAt, indexed, chunkCount }[]`, ordered by `crawledAt`
  desc. `chunkCount` via `SELECT COUNT(*) FROM chunks WHERE url=?` (or a grouped
  query). Powers the panel list on load.

- **`KnowledgeService.deleteSource(key)`** + **`KnowledgeStore.deletePage(url)`**
  — delete `vec_chunks` rows (by chunk id), `chunks` rows, and the `pages` row in
  one transaction (inverse of `upsertPage`'s delete step).

`canonical()`/`inScope()` are already exported (from the boot-crawl work) and are
not needed here — uploads use the `upload://` scheme directly.

### 2. web server — routes + ingest events

New `web/server/routes/knowledge.ts`:

- **`POST /api/knowledge/upload`** — body = raw file bytes; `X-Filename` header
  carries the name. One request per file (multi-file drop → N requests). No
  multipart parser needed. Server: enforce `UPLOAD_MAX_BYTES` (reject 413 if
  exceeded; cap the read), `formatOf(name)` allowlist (reject 415 with the skip
  reason), then `host.ingestFile(name, bytes)`. Responds `202 { accepted:true }`;
  result/progress arrives via SSE.

- **`POST /api/knowledge/url`** — `{ url }` → validate URL → `host.ingestUrl(url)`
  → `crawl({ seeds:[url] })`. `202`.

- **`GET /api/knowledge/sources`** → `{ sources: [...] }` (from `listSources()`).

- **`DELETE /api/knowledge/sources`** — `{ url }` → `deleteSource(url)` → `200`.

`EngineHost` gains:
- `ingestFile(name, bytes): Promise<void>` — `extractText` → `indexDocument`,
  emitting `ingest-status` for each phase; on parse skip emits a `skipped` event.
- `ingestUrl(url): Promise<void>` — `crawl({ seeds:[url] })`, emitting
  `crawling` → `indexed` (with counts from `CrawlResult`).
- Both go through the existing `emit()` → `SseHub.broadcast()`. These are
  fire-and-forget from the route (like `handleChat`): the route returns `202`
  and the SSE stream carries progress. Ingest is independent of `turnRunning`
  (it uses `runtime.knowledge`, not the LLM engine), so it can run mid-turn.

Routing added to `web/server/index.ts`'s `createApp` dispatcher; `clientDist`
SPA fallback unchanged.

### 3. client — Sources panel

- New `views/Sources.tsx`, reached via a new **Sources** sidebar entry
  (`App.tsx` `tab` union gains `"sources"`; `Sidebar` gains the nav item).
- **Dropzone**: native `onDragOver`/`onDragLeave`/`onDrop` on a styled region
  (reuse `Card`); hidden `<input type="file" multiple>` for the browse fallback.
  Client-side validation: extension allowlist + `UPLOAD_MAX_BYTES` (surfaced to
  the client via the existing `config-status` event — add `uploadMaxBytes`, or a
  small `GET` ; see Open Decisions). Invalid files are listed locally as
  skipped, never sent.
- **URL input** + Add button → `POST /api/knowledge/url`.
- **Ingested list**: on mount `GET /api/knowledge/sources`; rows show name
  (filename or host), chunk count, and a status badge. Live updates come from
  `ingest-status` SSE events via the **existing** `useServerStream` reducer.
- New client API helpers in `api.ts`: `uploadDocument(file)`, `addUrl(url)`,
  `listSources()`, `deleteSource(url)`.
- Multi-file drop sends files **sequentially** (one request each) to avoid
  piling concurrent embeds onto the single ONNX pipe.

## Events & client state

New shared event (`web/shared/events.ts`):
```
| { type: "ingest-status";
    source: string;                 // upload://name or the URL
    phase: "parsing" | "embedding" | "indexed" | "skipped" | "crawling";
    chunks?: number;                // on indexed
    reason?: string;                // on skipped
    detail?: string }               // e.g. "8/12" during embedding
```

`ChatState` (`web/client/src/state.ts`) gains an `ingest` slice — a map keyed by
`source` holding the latest phase/detail — updated in `applyServerEvent`'s new
`case "ingest-status"`. The Sources panel renders `listSources()` results
overlaid with live `ingest` entries (in-progress sources that aren't persisted
yet appear from the `ingest` map; finished ones reconcile to the list).

## Configuration

- New env `UPLOAD_MAX_BYTES` (core or web config), default `10485760` (10 MB).
  `CRAWL_MAX_BYTES` (2 MB) stays crawl-only — too small for typical PDFs.
- Format allowlist is derived from `EXT_TO_FORMAT` (single source of truth);
  client mirrors the same list.

## Safety / constraints

- Raw upload bytes are discarded after extraction — only extracted text and
  vectors are persisted.
- Content-hash dedup: identical re-upload is skipped; changed content re-indexes
  via `upsertPage` (old chunks replaced).
- Size cap + format allowlist enforced on **both** client and server.
- Server is local-only (127.0.0.1) and behind the app's existing auth gate, like
  all other routes; no new auth surface.
- Shared embedder: concurrent ingest + `search_knowledge` queue at the ONNX
  layer. Acceptable for a single-user local app; documented, not engineered
  around.

## Testing

- **core**
  - `indexDocument`: indexes chunks; hash-dedup skip on identical re-index;
    empty text → skipped; `onPhase` emits embedding progress. (fake embedder +
    in-memory store, mirroring existing `store.test.ts` `:memory:` pattern.)
  - `docparse`: `formatOf` maps modern exts incl. csv/txt, rejects `.ppt/.xls`;
    `extractText` returns skip on unknown format and on parser throw.
  - `listPages`/`deletePage`: round-trip insert → list → delete → gone (vec rows
    too).
- **web**
  - `knowledge` routes: upload happy path (202 + ingest events), oversize → 413,
    bad extension → 415, url add → crawl invoked, list, delete. (fake host
    capturing `ingestFile`/`ingestUrl`/events, mirroring existing
    `engine-host.test.ts` seams.)
  - `applyServerEvent` `ingest-status` reducer cases.
- **client**: dropzone validation (allowlist/size) unit-level if a seam exists;
  otherwise covered by the reducer + route tests.

## File-change summary

New:
- `core/src/clients/docparse/{index,extract,parsers,types}.ts` (relocated + csv/txt)
- `web/server/routes/knowledge.ts`
- `web/client/src/views/Sources.tsx`
- tests per above

Modified:
- `core/src/services/knowledge/index.ts` — `indexDocument`, `listSources`, `deleteSource`
- `core/src/services/knowledge/store.ts` — `listPages`, `deletePage`, `chunkCount`
- `core/src/clients/sharepoint/*` — import doc parsing from `docparse`
- `core/src/config.ts` (or web config) — `UPLOAD_MAX_BYTES`
- `web/server/engine-host.ts` — `ingestFile`, `ingestUrl`
- `web/server/index.ts` — route dispatch
- `web/shared/events.ts` — `ingest-status` event (+ optional `uploadMaxBytes` on config-status)
- `web/client/src/{state.ts,sse handling}` — `ingest` slice + reducer case
- `web/client/src/App.tsx`, `views/Sidebar.tsx` — Sources tab + nav
- `web/client/src/api.ts` — upload/addUrl/listSources/deleteSource

## Open decisions (defaults chosen, flag to change)

1. **Delete-source: included** — a Sources panel without removal is awkward.
2. **`UPLOAD_MAX_BYTES = 10 MB`** default.
3. **Surfacing the size/format limits to the client**: piggyback on the existing
   `config-status` event (add `uploadMaxBytes`) vs a dedicated `GET
   /api/knowledge/limits`. Leaning piggyback (no new round-trip).
