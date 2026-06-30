# UI Document & URL Ingest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a web UI "Sources" panel where a user drags in documents (PDF/DOCX/XLSX/PPTX/CSV/TXT) or pastes a URL, and they get parsed, chunked, embedded, and indexed into the knowledge store with live SSE status.

**Architecture:** Reuse the existing crawl/extract/chunk/embed/store pipeline. Lift the SharePoint text extractor into a shared `docparse` module; add a pure `indexDocument` ingest function (crawl's inner loop minus fetch) plus store list/delete; expose ingest on `EngineHost` emitting a new `ingest-status` SSE event; add web routes and a client Sources view fed by the existing single SSE stream.

**Tech Stack:** TypeScript (ESM, NodeNext), Node `node:http`, better-sqlite3 + sqlite-vec, transformers.js (ONNX) embedder, React 18 + Vite, Tailwind, vitest.

## Global Constraints

- No new runtime dependencies — `pdf-parse`, `mammoth`, `officeparser` are already in `packages/core/package.json`.
- ESM with explicit `.js` import specifiers (NodeNext); every relative import ends in `.js`.
- Tests: vitest. Per-package run, e.g. `npx vitest run packages/core/tests/<file>`. Node environment (no DOM) — client tests cover pure TS only.
- Store key for uploads: `upload://<filename>`. URL sources keep their canonical URL key.
- Modern formats only: `pdf docx xlsx pptx csv txt`. Legacy `.ppt/.xls` → skipped with a clear reason.
- `UPLOAD_MAX_BYTES` default `10485760` (10 MB). Enforced client and server.
- Raw upload bytes are discarded after extraction; only text + vectors persist.
- Branch: `feat/ui-document-url-ingest` (already created; spec committed there).
- Commit message trailer on every commit:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01Adeu4PXCABdfSMLf5bH7qo`

## File Structure

New:
- `packages/core/src/clients/docparse/types.ts` — `DocFormat`, `Parsers`, `ExtractResult` (home of truth).
- `packages/core/src/clients/docparse/parsers.ts` — `defaultParsers` (pdf/docx/xlsx/pptx/csv/txt).
- `packages/core/src/clients/docparse/extract.ts` — `extOf`, `formatOf`, `extractText`.
- `packages/core/src/clients/docparse/index.ts` — barrel.
- `packages/core/src/services/knowledge/ingest.ts` — pure `indexDocument(deps, doc, onPhase?)`.
- `packages/web/server/routes/knowledge.ts` — upload / url / list / delete handlers + `readBytes`.
- `packages/web/client/src/views/Sources.tsx` — the panel.
- `packages/web/client/src/views/sources-validate.ts` — pure client validation helper.
- Tests alongside each.

Modified:
- `packages/core/src/clients/sharepoint/{types,parsers,extract}.ts` — re-export from `docparse` (back-compat) / delete bodies.
- `packages/core/src/services/sharepoint/index.ts` — import parsing from `docparse`.
- `packages/core/src/services/knowledge/{store,index,types}.ts` — `listPages`/`deletePage`/`chunkCount`, service `indexDocument`/`listSources`/`deleteSource`, `SourceRow` type.
- `packages/core/src/index.ts` — export `docparse`.
- `packages/sre-agent/src/config.ts` — `UPLOAD_MAX_BYTES` env + `AgentConfig.uploadMaxBytes`.
- `packages/web/shared/events.ts` — `ingest-status` event + `uploadMaxBytes` on `config-status`.
- `packages/web/client/src/state.ts` — `ingest` slice + reducer cases.
- `packages/web/server/engine-host.ts` — `ingestFile`/`ingestUrl`/`listSources`/`deleteSource`/`uploadMaxBytes`, widen `runtimeFactory`, emit `uploadMaxBytes`.
- `packages/web/server/index.ts` — route dispatch.
- `packages/web/client/src/api.ts` — `uploadDocument`/`addUrl`/`listSources`/`deleteSource`.
- `packages/web/client/src/App.tsx`, `views/Sidebar.tsx` — `"sources"` tab + nav.

---

### Task 1: docparse module (relocate SharePoint extractor + add csv/txt)

**Files:**
- Create: `packages/core/src/clients/docparse/{types,parsers,extract,index}.ts`
- Create: `packages/core/tests/docparse.test.ts`
- Modify: `packages/core/src/clients/sharepoint/types.ts`, `packages/core/src/clients/sharepoint/parsers.ts`, `packages/core/src/clients/sharepoint/extract.ts`, `packages/core/src/services/sharepoint/index.ts`, `packages/core/src/index.ts`

**Interfaces:**
- Produces: `DocFormat = "docx"|"xlsx"|"pptx"|"pdf"|"csv"|"txt"`; `Parsers = Record<DocFormat,(b:Buffer)=>Promise<string>>`; `ExtractResult = {text:string}|{skipped:string}`; `extOf(name:string):string`; `formatOf(name:string):DocFormat|null`; `extractText(name:string,bytes:Buffer,parsers:Parsers):Promise<ExtractResult>`; `defaultParsers:Parsers`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/tests/docparse.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { extOf, formatOf, extractText } from "../src/clients/docparse/index.js";
import type { Parsers } from "../src/clients/docparse/index.js";

const fakeParsers = {
  docx: async () => "docx-text",
  xlsx: async () => "xlsx-text",
  pptx: async () => "pptx-text",
  pdf: async () => "pdf-text",
  csv: async (b: Buffer) => b.toString("utf8"),
  txt: async (b: Buffer) => b.toString("utf8")
} satisfies Parsers;

describe("docparse", () => {
  it("maps modern extensions including csv/txt", () => {
    expect(formatOf("a.pdf")).toBe("pdf");
    expect(formatOf("a.CSV")).toBe("csv");
    expect(formatOf("notes.txt")).toBe("txt");
    expect(extOf("x.PPTX")).toBe("pptx");
  });

  it("rejects legacy and unknown formats", () => {
    expect(formatOf("deck.ppt")).toBeNull();
    expect(formatOf("book.xls")).toBeNull();
    expect(formatOf("noext")).toBeNull();
  });

  it("extracts text for a known format", async () => {
    const r = await extractText("data.csv", Buffer.from("a,b\n1,2"), fakeParsers);
    expect(r).toEqual({ text: "a,b\n1,2" });
  });

  it("skips an unsupported format", async () => {
    const r = await extractText("deck.ppt", Buffer.from(""), fakeParsers);
    expect(r).toEqual({ skipped: "unsupported format: .ppt" });
  });

  it("skips on parser failure", async () => {
    const throwing = { ...fakeParsers, pdf: async () => { throw new Error("bad pdf"); } };
    const r = await extractText("x.pdf", Buffer.from(""), throwing);
    expect(r).toEqual({ skipped: "parse failed: bad pdf" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/tests/docparse.test.ts`
Expected: FAIL — cannot resolve `../src/clients/docparse/index.js`.

- [ ] **Step 3: Create the docparse module**

`packages/core/src/clients/docparse/types.ts`:
```ts
export type DocFormat = "docx" | "xlsx" | "pptx" | "pdf" | "csv" | "txt";

export type Parsers = Record<DocFormat, (b: Buffer) => Promise<string>>;

export type ExtractResult = { text: string } | { skipped: string };
```

`packages/core/src/clients/docparse/parsers.ts`:
```ts
import type { Parsers } from "./types.js";

/**
 * Real text extractors. Heavy parser libs are dynamically imported so they load
 * only when a document is actually ingested. `pdf-parse` is imported via its
 * inner module path to avoid its package index reading a sample PDF at import.
 */
export const defaultParsers: Parsers = {
  docx: async (b) => {
    const mammoth = await import("mammoth");
    const { value } = await mammoth.extractRawText({ buffer: b });
    return value;
  },
  xlsx: async (b) => {
    const op = await import("officeparser");
    const ast = await op.parseOffice(b);
    return ast.toText();
  },
  pptx: async (b) => {
    const op = await import("officeparser");
    const ast = await op.parseOffice(b);
    return ast.toText();
  },
  pdf: async (b) => {
    const { default: pdf } = await import("pdf-parse/lib/pdf-parse.js");
    const { text } = await pdf(b);
    return text;
  },
  csv: async (b) => b.toString("utf8"),
  txt: async (b) => b.toString("utf8")
};
```

`packages/core/src/clients/docparse/extract.ts`:
```ts
import type { Parsers, ExtractResult, DocFormat } from "./types.js";

const EXT_TO_FORMAT: Record<string, DocFormat> = {
  docx: "docx",
  xlsx: "xlsx",
  pptx: "pptx",
  pdf: "pdf",
  csv: "csv",
  txt: "txt"
};

export const extOf = (name: string): string => {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
};

export const formatOf = (name: string): DocFormat | null => EXT_TO_FORMAT[extOf(name)] ?? null;

/** Extract plain text from a document buffer. Unknown format or parser failure → a skip reason. */
export const extractText = async (name: string, bytes: Buffer, parsers: Parsers): Promise<ExtractResult> => {
  const format = formatOf(name);
  if (!format) return { skipped: `unsupported format: .${extOf(name)}` };
  try {
    const text = await parsers[format](bytes);
    return { text };
  } catch (err) {
    return { skipped: `parse failed: ${err instanceof Error ? err.message : String(err)}` };
  }
};
```

`packages/core/src/clients/docparse/index.ts`:
```ts
export * from "./types.js";
export * from "./extract.js";
export { defaultParsers } from "./parsers.js";
```

- [ ] **Step 4: Run the docparse test to verify it passes**

Run: `npx vitest run packages/core/tests/docparse.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Point SharePoint at docparse (no behavior change)**

Replace `packages/core/src/clients/sharepoint/types.ts` lines defining `ExtractResult` and `DocFormat` (currently `type ExtractResult = ...` and `type DocFormat = "docx" | "xlsx" | "pptx" | "pdf";`) with a re-export. At the top of the file add:
```ts
import type { DocFormat, Parsers, ExtractResult } from "../docparse/types.js";
export type { DocFormat, Parsers, ExtractResult };
```
Delete the old local `export type ExtractResult = ...`, `export type DocFormat = ...`, and the old `export interface Parsers { ... }` block from this file (now sourced from docparse). Leave all other types (`IncidentDocument`, etc.) intact — `IncidentDocument.format: DocFormat` still resolves via the re-export.

Replace the body of `packages/core/src/clients/sharepoint/parsers.ts` with:
```ts
export { defaultParsers } from "../docparse/parsers.js";
```

Replace the body of `packages/core/src/clients/sharepoint/extract.ts` with:
```ts
export { extOf, formatOf, extractText } from "../docparse/extract.js";
```

In `packages/core/src/index.ts`, add after the knowledge exports:
```ts
export * from "./clients/docparse/index.js";
```

- [ ] **Step 6: Verify SharePoint still compiles + tests pass**

Run: `npx tsc -b packages/core && npx vitest run packages/core`
Expected: tsc exit 0; all core tests PASS (existing SharePoint tests unchanged).

Note: `docparse` now also exports `formatOf`/`extOf`. `sharepoint/extract.ts` re-exports the same names; both reach the SAME symbols, so `export *` from core has no duplicate-name conflict (re-export of an already-exported binding). If tsc reports a duplicate export, drop the `export *` for sharepoint/extract — it is unused outside the package.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/clients/docparse packages/core/tests/docparse.test.ts \
  packages/core/src/clients/sharepoint/types.ts packages/core/src/clients/sharepoint/parsers.ts \
  packages/core/src/clients/sharepoint/extract.ts packages/core/src/index.ts
git commit -m "refactor(core): extract shared docparse module (+csv/txt)"
```

---

### Task 2: KnowledgeStore — listPages, deletePage, chunkCount

**Files:**
- Modify: `packages/core/src/services/knowledge/store.ts`, `packages/core/src/services/knowledge/types.ts`
- Test: `packages/core/tests/store.test.ts`

**Interfaces:**
- Produces: `SourceRow = { url:string; title?:string; crawledAt:number; indexed:boolean; chunkCount:number }`; `KnowledgeStore.listPages():SourceRow[]`; `KnowledgeStore.deletePage(url:string):void`.
- Consumes: existing `KnowledgeStore.upsertPage(UpsertPage)` (Task uses it to seed test data).

- [ ] **Step 1: Write the failing test**

Append to `packages/core/tests/store.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { KnowledgeStore } from "../src/services/knowledge/store.js";

describe("KnowledgeStore listPages/deletePage", () => {
  const seed = (s: KnowledgeStore, url: string, n: number, at: number) =>
    s.upsertPage({
      url, title: url, hash: "h" + url, crawledAt: at, indexed: true,
      chunks: Array.from({ length: n }, (_, i) => ({ ord: i, text: "t" + i, embedding: [0.1, 0.2, 0.3] }))
    });

  it("lists pages newest-first with chunk counts", () => {
    const s = new KnowledgeStore(":memory:", { model: "e", dim: 3 });
    seed(s, "upload://a.pdf", 2, 100);
    seed(s, "https://h/p", 3, 200);
    const rows = s.listPages();
    expect(rows.map((r) => r.url)).toEqual(["https://h/p", "upload://a.pdf"]);
    expect(rows[0]).toMatchObject({ chunkCount: 3, indexed: true });
    expect(rows[1].chunkCount).toBe(2);
    s.close();
  });

  it("deletePage removes the page and its chunks", () => {
    const s = new KnowledgeStore(":memory:", { model: "e", dim: 3 });
    seed(s, "upload://a.pdf", 2, 100);
    s.deletePage("upload://a.pdf");
    expect(s.listPages()).toEqual([]);
    expect(s.getPageHash("upload://a.pdf")).toBeUndefined();
    s.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/tests/store.test.ts`
Expected: FAIL — `s.listPages is not a function`.

- [ ] **Step 3: Add SourceRow type**

In `packages/core/src/services/knowledge/types.ts`, after `KnowledgeStats`:
```ts
/** A row for the Sources panel: one indexed page/document. */
export interface SourceRow {
  url: string;
  title?: string;
  crawledAt: number;
  indexed: boolean;
  chunkCount: number;
}
```

- [ ] **Step 4: Implement listPages + deletePage**

In `packages/core/src/services/knowledge/store.ts`, import the type at the top (extend the existing import from `./types.js`):
```ts
import type { SearchHit, KnowledgeStats, SourceRow } from "./types.js";
```
Add these methods to the `KnowledgeStore` class (after `stats()`):
```ts
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/core/tests/store.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/services/knowledge/store.ts packages/core/src/services/knowledge/types.ts packages/core/tests/store.test.ts
git commit -m "feat(core): KnowledgeStore.listPages + deletePage"
```

---

### Task 3: Pure indexDocument + KnowledgeService wiring

**Files:**
- Create: `packages/core/src/services/knowledge/ingest.ts`
- Create: `packages/core/tests/ingest.test.ts`
- Modify: `packages/core/src/services/knowledge/index.ts`

**Interfaces:**
- Produces:
  - `IngestDoc = { key:string; title?:string; text:string }`
  - `IngestResult = { indexed:boolean; chunks:number; skipped?:string }`
  - `IngestPhase = { phase:"embedding"; done:number; total:number } | { phase:"indexed"; chunks:number } | { phase:"skipped"; reason:string }`
  - `indexDocument(deps:{embedder:Pick<Embedder,"embed">; store:Pick<KnowledgeStore,"getPageHash"|"upsertPage">; now:()=>number}, doc:IngestDoc, onPhase?:(p:IngestPhase)=>void):Promise<IngestResult>`
  - `KnowledgeService.indexDocument(doc:IngestDoc, onPhase?):Promise<IngestResult>`
  - `KnowledgeService.listSources():Promise<SourceRow[]>`
  - `KnowledgeService.deleteSource(key:string):Promise<void>`
- Consumes: `sha256` (from `./crawl.js`), `chunkText` (from `./chunk.js`), `Embedder` (from `./types.js`), `KnowledgeStore` (Task 2 methods).

- [ ] **Step 1: Write the failing test**

Create `packages/core/tests/ingest.test.ts`:
```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/core/tests/ingest.test.ts`
Expected: FAIL — cannot resolve `ingest.js`.

- [ ] **Step 3: Implement the pure function**

Create `packages/core/src/services/knowledge/ingest.ts`:
```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/core/tests/ingest.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire into KnowledgeService**

In `packages/core/src/services/knowledge/index.ts`:
- Add imports:
```ts
import { indexDocument as runIndexDocument, type IngestDoc, type IngestPhase, type IngestResult } from "./ingest.js";
import type { SourceRow } from "./types.js";
```
- Add methods to the `KnowledgeService` class (after `crawl`):
```ts
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
```
- Re-export the ingest types for consumers (add near the top-level exports / end of file):
```ts
export type { IngestDoc, IngestPhase, IngestResult } from "./ingest.js";
```

- [ ] **Step 6: Typecheck + full core suite**

Run: `npx tsc -b packages/core && npx vitest run packages/core`
Expected: tsc exit 0; all core tests PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/services/knowledge/ingest.ts packages/core/tests/ingest.test.ts packages/core/src/services/knowledge/index.ts
git commit -m "feat(core): KnowledgeService.indexDocument/listSources/deleteSource"
```

---

### Task 4: UPLOAD_MAX_BYTES config

**Files:**
- Modify: `packages/sre-agent/src/config.ts`
- Test: `packages/sre-agent/tests/config.test.ts`

**Interfaces:**
- Produces: `AgentConfig.uploadMaxBytes: number` (default 10485760).

- [ ] **Step 1: Write the failing test**

Append to `packages/sre-agent/tests/config.test.ts` (inside the existing top-level `describe`, or a new one — match the file's existing base env helper; if the file builds env inline, replicate its minimal valid env):
```ts
import { describe, it, expect } from "vitest";
import { loadAgentConfig } from "../src/config.js";

const baseEnv = {
  SERVICENOW_BASE_URL: "https://x.service-now.com",
  SERVICENOW_USERNAME: "u",
  SERVICENOW_PASSWORD: "p",
  ADO_AUTH_MODE: "pat",
  ADO_ORG_URL: "https://dev.azure.com/o",
  ADO_PROJECT: "proj",
  ADO_PAT: "pat"
};

describe("uploadMaxBytes", () => {
  it("defaults to 10 MB", () => {
    expect(loadAgentConfig(baseEnv).uploadMaxBytes).toBe(10485760);
  });
  it("reads UPLOAD_MAX_BYTES", () => {
    expect(loadAgentConfig({ ...baseEnv, UPLOAD_MAX_BYTES: "2048" }).uploadMaxBytes).toBe(2048);
  });
});
```
Note: if `config.test.ts` already defines a `baseEnv`/helper, reuse it instead of redeclaring (avoid a duplicate-identifier compile error).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/sre-agent/tests/config.test.ts`
Expected: FAIL — `uploadMaxBytes` is undefined.

- [ ] **Step 3: Add the env + field**

In `packages/sre-agent/src/config.ts`:
- In the `schema` object, after `SHAREPOINT_ENABLED: bool(false),` (and the `CRAWL_TTL_HOURS` line if present), add:
```ts
  // Max bytes accepted for a single UI document upload. Default 10 MB.
  UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(10485760)
```
(ensure correct comma placement — it becomes the last property, so the property before it needs a trailing comma).
- In the `AgentConfig` interface, after `crawlTtlHours: number;`:
```ts
  /** Max bytes accepted for a single UI document upload. */
  uploadMaxBytes: number;
```
- In the returned object, after `crawlTtlHours: e.CRAWL_TTL_HOURS,`:
```ts
    uploadMaxBytes: e.UPLOAD_MAX_BYTES,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/sre-agent/tests/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sre-agent/src/config.ts packages/sre-agent/tests/config.test.ts
git commit -m "feat(agent): UPLOAD_MAX_BYTES config (default 10MB)"
```

---

### Task 5: ingest-status event + client reducer slice

**Files:**
- Modify: `packages/web/shared/events.ts`, `packages/web/client/src/state.ts`
- Test: `packages/web/tests/state.test.ts`

**Interfaces:**
- Produces: `ServerEvent` variant `{ type:"ingest-status"; source:string; phase:"parsing"|"embedding"|"indexed"|"skipped"|"crawling"; chunks?:number; reason?:string; detail?:string }`; `config-status` gains `uploadMaxBytes:number`; `ChatState.ingest: Record<string,{phase:string;detail?:string;chunks?:number;reason?:string}>`; `ChatState.config.uploadMaxBytes?:number`.

- [ ] **Step 1: Write the failing test**

Append to `packages/web/tests/state.test.ts`:
```ts
  it("tracks ingest-status per source", () => {
    let s = applyServerEvent(initialState, { type: "ingest-status", source: "upload://a.pdf", phase: "parsing" });
    s = applyServerEvent(s, { type: "ingest-status", source: "upload://a.pdf", phase: "embedding", detail: "2/5" });
    s = applyServerEvent(s, { type: "ingest-status", source: "https://h/p", phase: "crawling" });
    expect(s.ingest["upload://a.pdf"]).toEqual({ phase: "embedding", detail: "2/5", chunks: undefined, reason: undefined });
    expect(s.ingest["https://h/p"].phase).toBe("crawling");
  });

  it("stores uploadMaxBytes from config-status", () => {
    const s = applyServerEvent(initialState, {
      type: "config-status", llmMode: "seat", model: "m", servicenow: true, ado: false, rag: true, uploadMaxBytes: 2048
    });
    expect(s.config?.uploadMaxBytes).toBe(2048);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/web/tests/state.test.ts`
Expected: FAIL — `s.ingest` undefined / `uploadMaxBytes` missing.

- [ ] **Step 3: Add the event + config field**

In `packages/web/shared/events.ts`:
- Add to the `config-status` member, after `rag: boolean;`:
```ts
      uploadMaxBytes: number;
```
- Add a new union member (before the final `engine-state` member or after it):
```ts
  | {
      type: "ingest-status";
      source: string;
      phase: "parsing" | "embedding" | "indexed" | "skipped" | "crawling";
      chunks?: number;
      reason?: string;
      detail?: string;
    }
```

- [ ] **Step 4: Add the state slice + reducer cases**

In `packages/web/client/src/state.ts`:
- Add to `ChatState` interface:
```ts
  ingest: Record<string, { phase: string; detail?: string; chunks?: number; reason?: string }>;
```
- Add to `config` shape in `ChatState` (inside the `config?: { ... }` object), after `rag: boolean;`:
```ts
    uploadMaxBytes?: number;
```
- In `initialState`, add:
```ts
  ingest: {},
```
- In the `config-status` reducer case, add inside the `config: { ... }` object:
```ts
          uploadMaxBytes: e.uploadMaxBytes,
```
- Add a new case before `default:`:
```ts
    case "ingest-status":
      return {
        ...s,
        ingest: {
          ...s.ingest,
          [e.source]: { phase: e.phase, detail: e.detail, chunks: e.chunks, reason: e.reason }
        }
      };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/web/tests/state.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web/shared/events.ts packages/web/client/src/state.ts packages/web/tests/state.test.ts
git commit -m "feat(web): ingest-status event + client ingest slice"
```

---

### Task 6: EngineHost ingest methods

**Files:**
- Modify: `packages/web/server/engine-host.ts`
- Test: `packages/web/tests/engine-host.test.ts`

**Interfaces:**
- Consumes: `extractText`, `formatOf`, `defaultParsers` (from `@sre/core`); `runtime.knowledge.indexDocument`/`crawl`/`listSources`/`deleteSource`.
- Produces: `EngineHost.ingestFile(name:string, bytes:Buffer):Promise<void>`; `EngineHost.ingestUrl(url:string):Promise<void>`; `EngineHost.listSources():Promise<SourceRow[]>`; `EngineHost.deleteSource(url:string):Promise<void>`; `EngineHost.uploadMaxBytes:number`. Emits `ingest-status` events.

- [ ] **Step 1: Write the failing test**

Append to `packages/web/tests/engine-host.test.ts` (this suite already builds a host with `emit`/`runtimeFactory` seams — match its existing setup; the block below shows the shape):
```ts
import { describe, it, expect, vi } from "vitest";
import { createEngineHost } from "../server/engine-host.js";
import type { ServerEvent } from "../shared/events.js";

// Minimal config + tools to satisfy createEngineHost. If the file already has a
// `baseOpts`/helper, reuse it and only override engineFactory/runtimeFactory/emit.
const fakeEngine = {
  start: async () => {}, stop: async () => {}, abort: async () => {},
  send: async () => {}, getAuthStatus: async () => ({ isAuthenticated: true })
} as any;

describe("EngineHost ingest", () => {
  it("ingestFile extracts then indexes, emitting status", async () => {
    const events: ServerEvent[] = [];
    const knowledge = {
      close: async () => {},
      indexDocument: vi.fn(async (_doc: any, onPhase: (p: any) => void) => {
        onPhase({ phase: "embedding", done: 0, total: 1 });
        return { indexed: true, chunks: 1 };
      }),
      crawl: vi.fn(),
      listSources: vi.fn(async () => []),
      deleteSource: vi.fn()
    };
    const host = createEngineHost({
      config: { uploadMaxBytes: 1000 } as any,
      tools: [],
      engineFactory: () => fakeEngine,
      emit: (e) => events.push(e),
      runtimeFactory: () => ({ knowledge }) as any
    });
    await host.ingestFile("notes.txt", Buffer.from("hello"));
    expect(knowledge.indexDocument).toHaveBeenCalledWith(
      expect.objectContaining({ key: "upload://notes.txt", title: "notes.txt", text: "hello" }),
      expect.any(Function)
    );
    expect(events.map((e) => e.type)).toContain("ingest-status");
    expect(events.some((e) => e.type === "ingest-status" && e.phase === "indexed" && e.chunks === 1)).toBe(true);
  });

  it("ingestFile emits skipped for an unsupported format", async () => {
    const events: ServerEvent[] = [];
    const knowledge = { close: async () => {}, indexDocument: vi.fn(), crawl: vi.fn(), listSources: vi.fn(), deleteSource: vi.fn() };
    const host = createEngineHost({
      config: { uploadMaxBytes: 1000 } as any, tools: [],
      engineFactory: () => fakeEngine, emit: (e) => events.push(e),
      runtimeFactory: () => ({ knowledge }) as any
    });
    await host.ingestFile("deck.ppt", Buffer.from("x"));
    expect(knowledge.indexDocument).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === "ingest-status" && e.phase === "skipped")).toBe(true);
  });

  it("ingestUrl crawls the single seed and emits indexed", async () => {
    const events: ServerEvent[] = [];
    const knowledge = {
      close: async () => {}, indexDocument: vi.fn(),
      crawl: vi.fn(async () => ({ pagesCrawled: 1, pagesIndexed: 1, pagesSkipped: 0, chunksAdded: 4, dropped: 0 })),
      listSources: vi.fn(), deleteSource: vi.fn()
    };
    const host = createEngineHost({
      config: { uploadMaxBytes: 1000 } as any, tools: [],
      engineFactory: () => fakeEngine, emit: (e) => events.push(e),
      runtimeFactory: () => ({ knowledge }) as any
    });
    await host.ingestUrl("https://h/p");
    expect(knowledge.crawl).toHaveBeenCalledWith({ seeds: ["https://h/p"] });
    expect(events.some((e) => e.type === "ingest-status" && e.phase === "indexed" && e.chunks === 4)).toBe(true);
  });
});
```
If `createEngineHost`'s required `config` shape makes `{ uploadMaxBytes } as any` insufficient at runtime (it only reads `config.copilot`, `config.llm` lazily in paths not exercised here), keep the `as any`. Adjust to the file's existing fake config if one exists.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/web/tests/engine-host.test.ts`
Expected: FAIL — `host.ingestFile is not a function`.

- [ ] **Step 3: Widen the runtimeFactory seam + add imports**

In `packages/web/server/engine-host.ts`:
- Extend the `@sre/sre-agent` import? No — these come from core. Add an import from `@sre/core`:
```ts
import { extractText, formatOf, defaultParsers } from "@sre/core";
import type { SourceRow, IngestDoc, IngestPhase, IngestResult } from "@sre/core";
```
- Replace the narrow `runtimeFactory` option type. Find:
```ts
  runtimeFactory?: () => { knowledge: { close(): Promise<unknown> } };
```
Replace with:
```ts
  /** Seam: builds the ONNX/knowledge runtime; tests inject a lightweight fake. */
  runtimeFactory?: () => {
    knowledge: {
      close(): Promise<unknown>;
      indexDocument(doc: IngestDoc, onPhase?: (p: IngestPhase) => void): Promise<IngestResult>;
      crawl(overrides: { seeds?: string[] }, log?: (m: string) => void): Promise<{ chunksAdded: number }>;
      listSources(): Promise<SourceRow[]>;
      deleteSource(key: string): Promise<void>;
    };
  };
```

- [ ] **Step 4: Add the methods to the interface + implementation**

In the `EngineHost` interface (after `abort()` / near other methods):
```ts
  ingestFile(name: string, bytes: Buffer): Promise<void>;
  ingestUrl(url: string): Promise<void>;
  listSources(): Promise<SourceRow[]>;
  deleteSource(url: string): Promise<void>;
  uploadMaxBytes: number;
```

In the returned object of `createEngineHost`, add (after `abort`):
```ts
    uploadMaxBytes: config.uploadMaxBytes,
    async ingestFile(name, bytes) {
      const source = `upload://${name}`;
      if (!runtime) {
        emit({ type: "ingest-status", source, phase: "skipped", reason: "knowledge index not configured" });
        return;
      }
      if (!formatOf(name)) {
        emit({ type: "ingest-status", source, phase: "skipped", reason: `unsupported format` });
        return;
      }
      emit({ type: "ingest-status", source, phase: "parsing" });
      const ex = await extractText(name, bytes, defaultParsers);
      if ("skipped" in ex) {
        emit({ type: "ingest-status", source, phase: "skipped", reason: ex.skipped });
        return;
      }
      const res = await runtime.knowledge.indexDocument(
        { key: source, title: name, text: ex.text },
        (p) => {
          if (p.phase === "embedding") {
            emit({ type: "ingest-status", source, phase: "embedding", detail: `${p.done}/${p.total}` });
          }
        }
      );
      if (res.skipped) emit({ type: "ingest-status", source, phase: "skipped", reason: res.skipped });
      else emit({ type: "ingest-status", source, phase: "indexed", chunks: res.chunks });
    },
    async ingestUrl(url) {
      if (!runtime) {
        emit({ type: "ingest-status", source: url, phase: "skipped", reason: "knowledge index not configured" });
        return;
      }
      emit({ type: "ingest-status", source: url, phase: "crawling" });
      const res = await runtime.knowledge.crawl({ seeds: [url] });
      emit({ type: "ingest-status", source: url, phase: "indexed", chunks: res.chunksAdded });
    },
    async listSources() {
      return runtime ? runtime.knowledge.listSources() : [];
    },
    async deleteSource(url) {
      await runtime?.knowledge.deleteSource(url);
    },
```
Note: `runtime` is the existing `let runtime = runtimeFactory?.()` binding already in `createEngineHost`. `config` is the existing captured option.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/web/tests/engine-host.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `npx tsc -b packages/web`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/web/server/engine-host.ts packages/web/tests/engine-host.test.ts
git commit -m "feat(web): EngineHost ingestFile/ingestUrl/listSources/deleteSource"
```

---

### Task 7: Web knowledge routes + readBytes + dispatch

**Files:**
- Create: `packages/web/server/routes/knowledge.ts`
- Modify: `packages/web/server/routes/util.ts`, `packages/web/server/index.ts`
- Test: `packages/web/tests/routes.test.ts`

**Interfaces:**
- Consumes: `EngineHost.ingestFile/ingestUrl/listSources/deleteSource/uploadMaxBytes` (Task 6); `formatOf`/`extOf` (`@sre/core`); `readJson`/`sendJson` (existing util).
- Produces: `handleUpload`, `handleAddUrl`, `handleListSources`, `handleDeleteSource`; `readBytes(req, maxBytes)`.

- [ ] **Step 1: Write the failing test**

Append to `packages/web/tests/routes.test.ts` (reuse the file's existing request/response mock helpers; the shape below assumes a `mockReq`/`mockRes` pattern — match what the file already uses for `handleChat`):
```ts
import { describe, it, expect, vi } from "vitest";
import { handleUpload, handleAddUrl, handleListSources, handleDeleteSource } from "../server/routes/knowledge.js";

// Build a fake IncomingMessage that yields `body` bytes and carries headers.
const reqOf = (headers: Record<string, string>, body = Buffer.from("")) => {
  async function* gen() { yield body; }
  return Object.assign(gen(), { headers });
};
const resOf = () => {
  const r: any = { statusCode: 0, body: "", writeHead: (s: number) => { r.statusCode = s; }, end: (b?: string) => { r.body = b ?? ""; } };
  return r;
};
const hostOf = () => ({
  uploadMaxBytes: 1000,
  ingestFile: vi.fn(async () => {}),
  ingestUrl: vi.fn(async () => {}),
  listSources: vi.fn(async () => [{ url: "upload://a", title: "a", crawledAt: 1, indexed: true, chunkCount: 2 }]),
  deleteSource: vi.fn(async () => {})
}) as any;

describe("knowledge routes", () => {
  it("upload accepts a supported file and calls ingestFile", async () => {
    const host = hostOf();
    const res = resOf();
    await handleUpload(reqOf({ "x-filename": "notes.txt" }, Buffer.from("hi")), res, host, host.uploadMaxBytes);
    expect(res.statusCode).toBe(202);
    expect(host.ingestFile).toHaveBeenCalledWith("notes.txt", expect.any(Buffer));
  });

  it("upload rejects an unsupported format with 415", async () => {
    const host = hostOf();
    const res = resOf();
    await handleUpload(reqOf({ "x-filename": "deck.ppt" }, Buffer.from("x")), res, host, host.uploadMaxBytes);
    expect(res.statusCode).toBe(415);
    expect(host.ingestFile).not.toHaveBeenCalled();
  });

  it("upload rejects oversize with 413", async () => {
    const host = hostOf();
    const res = resOf();
    await handleUpload(reqOf({ "x-filename": "a.txt" }, Buffer.alloc(2000)), res, host, host.uploadMaxBytes);
    expect(res.statusCode).toBe(413);
    expect(host.ingestFile).not.toHaveBeenCalled();
  });

  it("url add validates and calls ingestUrl", async () => {
    const host = hostOf();
    const res = resOf();
    await handleAddUrl(reqOf({}, Buffer.from(JSON.stringify({ url: "https://h/p" }))), res, host);
    expect(res.statusCode).toBe(202);
    expect(host.ingestUrl).toHaveBeenCalledWith("https://h/p");
  });

  it("url add rejects an invalid url with 400", async () => {
    const host = hostOf();
    const res = resOf();
    await handleAddUrl(reqOf({}, Buffer.from(JSON.stringify({ url: "not a url" }))), res, host);
    expect(res.statusCode).toBe(400);
    expect(host.ingestUrl).not.toHaveBeenCalled();
  });

  it("list returns sources", async () => {
    const host = hostOf();
    const res = resOf();
    await handleListSources(reqOf({}), res, host);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).sources).toHaveLength(1);
  });

  it("delete calls deleteSource", async () => {
    const host = hostOf();
    const res = resOf();
    await handleDeleteSource(reqOf({}, Buffer.from(JSON.stringify({ url: "upload://a" }))), res, host);
    expect(res.statusCode).toBe(200);
    expect(host.deleteSource).toHaveBeenCalledWith("upload://a");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/web/tests/routes.test.ts`
Expected: FAIL — cannot resolve `knowledge.js`.

- [ ] **Step 3: Add readBytes to util**

In `packages/web/server/routes/util.ts`, append:
```ts
/** Read a request body as raw bytes, rejecting once it exceeds maxBytes. */
export const readBytes = async (req: IncomingMessage, maxBytes: number): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    total += (c as Buffer).length;
    if (total > maxBytes) throw new Error("payload too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
};
```

- [ ] **Step 4: Implement the routes**

Create `packages/web/server/routes/knowledge.ts`:
```ts
import type { IncomingMessage, ServerResponse } from "node:http";
import { formatOf, extOf } from "@sre/core";
import type { EngineHost } from "../engine-host.js";
import { readJson, sendJson, readBytes } from "./util.js";

export const handleUpload = async (
  req: IncomingMessage,
  res: ServerResponse,
  host: EngineHost,
  maxBytes: number
) => {
  const raw = req.headers["x-filename"];
  if (typeof raw !== "string" || !raw) return sendJson(res, 400, { error: "missing X-Filename header" });
  const name = decodeURIComponent(raw);
  if (!formatOf(name)) return sendJson(res, 415, { error: `unsupported format: .${extOf(name)}` });
  let bytes: Buffer;
  try {
    bytes = await readBytes(req, maxBytes);
  } catch {
    return sendJson(res, 413, { error: "file exceeds upload size limit" });
  }
  void host.ingestFile(name, bytes).catch(() => {}); // progress + errors surface via ingest-status SSE
  sendJson(res, 202, { accepted: true });
};

export const handleAddUrl = async (req: IncomingMessage, res: ServerResponse, host: EngineHost) => {
  const { url } = await readJson<{ url: string }>(req);
  try {
    new URL(url);
  } catch {
    return sendJson(res, 400, { error: "invalid url" });
  }
  void host.ingestUrl(url).catch(() => {});
  sendJson(res, 202, { accepted: true });
};

export const handleListSources = async (_req: IncomingMessage, res: ServerResponse, host: EngineHost) => {
  sendJson(res, 200, { sources: await host.listSources() });
};

export const handleDeleteSource = async (req: IncomingMessage, res: ServerResponse, host: EngineHost) => {
  const { url } = await readJson<{ url: string }>(req);
  await host.deleteSource(url);
  sendJson(res, 200, { ok: true });
};
```

- [ ] **Step 5: Wire the dispatch**

In `packages/web/server/index.ts`:
- Add to the route imports:
```ts
import { handleUpload, handleAddUrl, handleListSources, handleDeleteSource } from "./routes/knowledge.js";
```
- In `createApp`'s dispatcher, after the existing `POST /api/abort` line, add:
```ts
      if (m === "POST /api/knowledge/upload") return void (await handleUpload(req, res, host, host.uploadMaxBytes));
      if (m === "POST /api/knowledge/url") return void (await handleAddUrl(req, res, host));
      if (m === "GET /api/knowledge/sources") return void (await handleListSources(req, res, host));
      if (m === "DELETE /api/knowledge/sources") return void (await handleDeleteSource(req, res, host));
```

- [ ] **Step 6: Run tests + typecheck**

Run: `npx vitest run packages/web/tests/routes.test.ts && npx tsc -b packages/web`
Expected: routes test PASS; tsc exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/web/server/routes/knowledge.ts packages/web/server/routes/util.ts packages/web/server/index.ts packages/web/tests/routes.test.ts
git commit -m "feat(web): knowledge ingest routes (upload/url/list/delete)"
```

---

### Task 8: Client API helpers + validation

**Files:**
- Modify: `packages/web/client/src/api.ts`
- Create: `packages/web/client/src/views/sources-validate.ts`
- Test: `packages/web/tests/sources-validate.test.ts`

**Interfaces:**
- Produces: `uploadDocument(file:File):Promise<Response>`; `addUrl(url:string):Promise<Response>`; `listSources():Promise<{sources:SourceRow[]}>`; `deleteSource(url:string):Promise<Response>`; `ACCEPTED_EXTS:string[]`; `validateFile(file:{name:string;size:number}, maxBytes:number):{ok:true}|{ok:false;reason:string}`.

- [ ] **Step 1: Write the failing test**

Create `packages/web/tests/sources-validate.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { validateFile, ACCEPTED_EXTS } from "../client/src/views/sources-validate.js";

describe("validateFile", () => {
  it("accepts a supported, in-size file", () => {
    expect(validateFile({ name: "a.pdf", size: 100 }, 1000)).toEqual({ ok: true });
  });
  it("rejects an unsupported extension", () => {
    expect(validateFile({ name: "deck.ppt", size: 1 }, 1000)).toEqual({ ok: false, reason: "unsupported format: .ppt" });
  });
  it("rejects an oversize file", () => {
    const r = validateFile({ name: "a.pdf", size: 2000 }, 1000);
    expect(r.ok).toBe(false);
  });
  it("exposes the accepted extension list", () => {
    expect(ACCEPTED_EXTS).toEqual(["pdf", "docx", "xlsx", "pptx", "csv", "txt"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/web/tests/sources-validate.test.ts`
Expected: FAIL — cannot resolve module.

- [ ] **Step 3: Implement the validation helper**

Create `packages/web/client/src/views/sources-validate.ts`:
```ts
export const ACCEPTED_EXTS = ["pdf", "docx", "xlsx", "pptx", "csv", "txt"];

const extOf = (name: string): string => {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
};

export const validateFile = (
  file: { name: string; size: number },
  maxBytes: number
): { ok: true } | { ok: false; reason: string } => {
  const ext = extOf(file.name);
  if (!ACCEPTED_EXTS.includes(ext)) return { ok: false, reason: `unsupported format: .${ext}` };
  if (file.size > maxBytes) return { ok: false, reason: `exceeds ${Math.round(maxBytes / 1048576)} MB limit` };
  return { ok: true };
};
```

- [ ] **Step 4: Add the API helpers**

In `packages/web/client/src/api.ts`:
- Add a `SourceRow` import (type) — re-declare locally to avoid cross-package import in the client bundle:
```ts
export interface SourceRow { url: string; title?: string; crawledAt: number; indexed: boolean; chunkCount: number }
```
- Append:
```ts
export const uploadDocument = (file: File) =>
  fetch("/api/knowledge/upload", {
    method: "POST",
    headers: { "x-filename": encodeURIComponent(file.name), "content-type": "application/octet-stream" },
    body: file
  });

export const addUrl = (url: string) => post("/api/knowledge/url", { url });

export const listSources = () =>
  fetch("/api/knowledge/sources").then((r) => r.json() as Promise<{ sources: SourceRow[] }>);

export const deleteSource = (url: string) =>
  fetch("/api/knowledge/sources", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url })
  });
```
(`post` is the existing helper at the top of the file.)

- [ ] **Step 5: Run test + typecheck**

Run: `npx vitest run packages/web/tests/sources-validate.test.ts && npx tsc -b packages/web`
Expected: PASS; tsc exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/web/client/src/api.ts packages/web/client/src/views/sources-validate.ts packages/web/tests/sources-validate.test.ts
git commit -m "feat(web): client knowledge API + file validation"
```

---

### Task 9: Sources view + sidebar/app navigation

**Files:**
- Create: `packages/web/client/src/views/Sources.tsx`
- Modify: `packages/web/client/src/App.tsx`, `packages/web/client/src/views/Sidebar.tsx`

**Interfaces:**
- Consumes: `ChatState` (`state.ingest`, `state.config?.uploadMaxBytes`), `uploadDocument`/`addUrl`/`listSources`/`deleteSource`/`SourceRow` (Task 8), `validateFile`/`ACCEPTED_EXTS` (Task 8), `Button`, `Card`.
- Produces: `Sources` component; `tab` union extended to `"chat" | "settings" | "sources"`.

- [ ] **Step 1: Extend the tab union (App + Sidebar)**

In `packages/web/client/src/App.tsx`:
- Change the `tab` state type:
```ts
  const [tab, setTab] = useState<"chat" | "settings" | "sources">("chat");
```
- Add the import:
```ts
import { Sources } from "./views/Sources.js";
```
- In the `<main>` render, change the conditional to include sources:
```tsx
        <main className="flex-1 overflow-hidden">
          {tab === "chat" ? (
            <Chat state={state} onSend={send} input={input} setInput={setInput} />
          ) : tab === "sources" ? (
            <Sources state={state} />
          ) : (
            <EnvSettings />
          )}
        </main>
```

In `packages/web/client/src/views/Sidebar.tsx`:
- Update both the prop types `tab` and `onTab` (lines ~30-31) to the three-value union:
```ts
  tab: "chat" | "settings" | "sources";
  onTab: (t: "chat" | "settings" | "sources") => void;
```
- Add a nav button between Chat and Settings (mirror the existing button markup):
```tsx
        <button
          onClick={() => onTab("sources")}
          aria-current={tab === "sources" ? "page" : undefined}
          className={"text-left px-2 py-1.5 rounded transition-colors " + (tab === "sources" ? "bg-surface-container text-primary-container" : "text-on-surface-variant hover:bg-surface-container")}
        >
          Sources
        </button>
```

- [ ] **Step 2: Implement the Sources view**

Create `packages/web/client/src/views/Sources.tsx`:
```tsx
import { useEffect, useRef, useState } from "react";
import type { ChatState } from "../state.js";
import { uploadDocument, addUrl, listSources, deleteSource, type SourceRow } from "../api.js";
import { validateFile, ACCEPTED_EXTS } from "./sources-validate.js";
import { Button } from "./ui/Button.js";
import { Card } from "./ui/Card.js";

const DEFAULT_MAX = 10 * 1048576;

export function Sources({ state }: { state: ChatState }) {
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [url, setUrl] = useState("");
  const [localErrors, setLocalErrors] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const maxBytes = state.config?.uploadMaxBytes ?? DEFAULT_MAX;

  const refresh = () => listSources().then((r) => setSources(r.sources)).catch(() => {});
  useEffect(() => { refresh(); }, []);
  // When any in-flight ingest reaches a terminal phase, re-pull the list.
  const ingestKey = JSON.stringify(state.ingest);
  useEffect(() => {
    if (Object.values(state.ingest).some((i) => i.phase === "indexed")) refresh();
  }, [ingestKey]);

  const sendFiles = async (files: FileList | File[]) => {
    const errs: string[] = [];
    for (const f of Array.from(files)) {
      const v = validateFile(f, maxBytes);
      if (!v.ok) { errs.push(`${f.name}: ${v.reason}`); continue; }
      await uploadDocument(f); // sequential: one shared embedder
    }
    setLocalErrors(errs);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files?.length) void sendFiles(e.dataTransfer.files);
  };

  const submitUrl = (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    void addUrl(url.trim());
    setUrl("");
  };

  const remove = async (u: string) => { await deleteSource(u); refresh(); };

  // In-flight sources not yet in the persisted list.
  const inFlight = Object.entries(state.ingest).filter(
    ([src, i]) => i.phase !== "indexed" && !sources.some((s) => s.url === src)
  );

  const label = (u: string) => (u.startsWith("upload://") ? u.slice("upload://".length) : u);
  const statusText = (i: { phase: string; detail?: string; reason?: string }) =>
    i.phase === "embedding" ? `embedding ${i.detail ?? ""}…`
      : i.phase === "skipped" ? `skipped: ${i.reason ?? ""}`
      : i.phase === "crawling" ? "crawling…"
      : i.phase === "parsing" ? "parsing…"
      : i.phase;

  return (
    <div className="max-w-container mx-auto w-full p-6 space-y-5 overflow-auto h-full">
      <h2 className="text-headline-md">Sources</h2>

      <Card
        className={"p-8 text-center border-2 border-dashed transition-colors " +
          (dragging ? "border-primary-container bg-primary-container/5" : "border-outline")}
      >
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className="space-y-3"
        >
          <p className="text-body-lg text-on-surface">Drag documents here</p>
          <p className="text-label-sm text-on-surface-variant uppercase tracking-wide">
            {ACCEPTED_EXTS.join(" · ")}
          </p>
          <Button type="button" variant="outline" onClick={() => fileInput.current?.click()}>
            Browse files
          </Button>
          <input
            ref={fileInput}
            type="file"
            multiple
            accept={ACCEPTED_EXTS.map((e) => "." + e).join(",")}
            className="hidden"
            onChange={(e) => { if (e.target.files) void sendFiles(e.target.files); e.target.value = ""; }}
          />
        </div>
      </Card>

      <form onSubmit={submitUrl} className="flex gap-3">
        <input
          aria-label="URL to crawl"
          className="flex-1 border border-outline rounded px-3 py-2 text-body-md focus-visible:border-primary-container"
          placeholder="https://internal-wiki/page"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <Button type="submit">Add URL</Button>
      </form>

      {localErrors.length > 0 && (
        <div role="alert" className="text-label-md text-error space-y-1">
          {localErrors.map((e) => <div key={e}>{e}</div>)}
        </div>
      )}

      <Card className="divide-y divide-surface-gray">
        {inFlight.map(([src, i]) => (
          <div key={src} className="flex items-center justify-between px-4 py-3">
            <span className="truncate text-body-md">{label(src)}</span>
            <span className="text-label-sm text-on-surface-variant">{statusText(i)}</span>
          </div>
        ))}
        {sources.map((s) => {
          const live = state.ingest[s.url];
          return (
            <div key={s.url} className="flex items-center justify-between px-4 py-3 gap-3">
              <span className="truncate text-body-md">{label(s.url)}</span>
              <span className="shrink-0 text-label-sm text-on-surface-variant">
                {live && live.phase !== "indexed" ? statusText(live) : `${s.chunkCount} chunks`}
              </span>
              <button
                onClick={() => void remove(s.url)}
                className="shrink-0 text-label-sm text-error hover:underline"
                aria-label={`Remove ${label(s.url)}`}
              >
                Remove
              </button>
            </div>
          );
        })}
        {sources.length === 0 && inFlight.length === 0 && (
          <div className="px-4 py-6 text-center text-on-surface-variant text-body-md">No sources indexed yet.</div>
        )}
      </Card>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck the client**

Run: `npx tsc -b packages/web`
Expected: exit 0. (No DOM unit test — component covered by the reducer + validation + route tests.)

- [ ] **Step 4: Build the client to confirm it bundles**

Run: `cd packages/web && npx vite build && cd ../..`
Expected: build succeeds, emits `client/dist`.

- [ ] **Step 5: Commit**

```bash
git add packages/web/client/src/views/Sources.tsx packages/web/client/src/App.tsx packages/web/client/src/views/Sidebar.tsx
git commit -m "feat(web): Sources panel (drag-drop docs + add URL)"
```

---

### Task 10: Full-suite verification + manual smoke

**Files:** none (verification only).

- [ ] **Step 1: Typecheck the whole repo**

Run: `npx tsc -b packages/core packages/sre-agent packages/web packages/mcp-server`
Expected: exit 0.

- [ ] **Step 2: Run the full test suite**

Run: `npx vitest run`
Expected: all packages PASS (previous 307 + new docparse/store/ingest/state/engine-host/routes/sources-validate tests).

- [ ] **Step 3: Manual smoke (mock backend, like the scroll-fix verification)**

Reuse the mock pattern from the scroll-bug session, extended with the four
`/api/knowledge/*` routes returning canned `ingest-status` SSE frames, OR run the
real server if Copilot auth + `CRAWL_SEEDS` are configured. Verify in the browser:
- Sources tab appears; dropping a `.txt` shows `parsing → embedding → indexed` and the row lands in the list with a chunk count.
- A `.ppt` is rejected client-side with the unsupported-format message.
- Adding a URL shows `crawling → indexed`.
- Remove deletes the row.

- [ ] **Step 4: Final commit (if any smoke fixes were needed)**

```bash
git add -A
git commit -m "test(web): verify document & URL ingest end to end"
```

---

## Self-Review

**Spec coverage:**
- Generalize doc parsing + csv/txt → Task 1. ✓
- `indexDocument` (hash-dedup, chunk, embed, upsert) → Task 3. ✓
- `listSources`/`deleteSource` + store methods → Tasks 2, 3. ✓
- `UPLOAD_MAX_BYTES` (default 10MB) → Task 4. ✓
- `ingest-status` event + `uploadMaxBytes` on config-status + client slice → Task 5. ✓
- `EngineHost.ingestFile/ingestUrl/listSources/deleteSource` emitting events → Task 6. ✓
- Routes upload (raw bytes + `X-Filename`, 413/415), url, list, delete + dispatch → Task 7. ✓
- Client API + validation (allowlist/size) → Task 8. ✓
- Sources panel (dropzone, URL, live status, remove) + nav → Task 9. ✓
- Safety: size cap both sides (Tasks 7, 8), format allowlist both sides (Tasks 1/7, 8), bytes discarded (Task 3 stores only text+vectors), hash-dedup (Task 3), local-only/auth gate (unchanged, Tasks 7/9). ✓
- Decision #3 (limits via config-status piggyback) → Tasks 5, 6. ✓
- Testing per spec (core ingest/docparse/store, web routes/reducer/validation) → all tasks. ✓

**Placeholder scan:** No TBD/TODO; every code + test step has concrete content. ✓

**Type consistency:** `indexDocument`/`IngestDoc`/`IngestPhase`/`IngestResult` identical across Tasks 3, 6. `SourceRow` shape identical across Tasks 2, 6, 7, 8. `ingest-status` event fields identical across Tasks 5, 6. `formatOf`/`extOf` reused from Task 1 in Tasks 6, 7. `uploadMaxBytes` consistent across Tasks 4, 5, 6, 7, 9. ✓

**Known seam caveats (flagged in-task, not blockers):**
- Task 1 Step 6: possible `export *` duplicate-name with sharepoint re-export — fallback documented.
- Task 6 Step 1 / Task 7 Step 1: tests must reuse the files' existing mock helpers; shapes shown are illustrative and may need to match the established harness.
