# Internal Smart Crawler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an LLM-guided crawler over internal documentation sites that builds a persistent semantic index the SRE agent queries during chat.

**Architecture:** New crawler client + `knowledge` service in `@sre/core` (fetch via existing `proxy.ts`, content extraction, local-Ollama LLM gate + embeddings, sqlite-vec store). One `crawl.ts` orchestrator is driven by both a new `sre-agent crawl` CLI command (full ingest) and a bounded in-agent `index_url` tool. The agent gets a `search_knowledge` read tool. Tools are projected in both `sre-agent` and `mcp-server`, matching the existing `runtime.<service>` pattern.

**Tech Stack:** TypeScript (ESM, NodeNext), `undici` (already present), `better-sqlite3` + `sqlite-vec`, `linkedom` + `@mozilla/readability`, `zod`, `vitest`. Local Ollama (OpenAI-compatible `/v1`) for the crawl-brain chat model and `nomic-embed-text` embeddings.

**Conventions to follow (from the existing codebase):**
- ESM imports use explicit `.js` extensions even for `.ts` sources.
- HTTP uses `import { fetch } from "undici"` with `dispatcher: proxyDispatcher(proxyUrl)`.
- Config parsed with `zod` in `packages/core/src/config.ts`; empty-string env → `undefined` via the `optional()` helper.
- Tests use `vitest` (`describe/it/expect/vi`); dependencies injected as fakes (see `packages/sre-agent/tests/engine.test.ts`).
- Tool handlers `try/catch` and return `{ error: String(err) }`; never throw.
- Run all tests from repo root: `npm test` (vitest workspace). Run one project: `npx vitest run --project core`.

---

## File Structure

**Create:**
- `packages/core/src/clients/crawler/fetcher.ts` — HTTP GET via undici+proxy, guards.
- `packages/core/src/clients/crawler/extract.ts` — HTML → `{title, mainText, links}`.
- `packages/core/src/clients/crawler/robots.ts` — robots.txt allow/deny.
- `packages/core/src/clients/llm.ts` — Ollama chat + embed over undici.
- `packages/core/src/services/knowledge/types.ts` — shared interfaces.
- `packages/core/src/services/knowledge/chunk.ts` — text chunking.
- `packages/core/src/services/knowledge/store.ts` — sqlite-vec store.
- `packages/core/src/services/knowledge/crawl.ts` — LLM-guided BFS orchestrator.
- `packages/core/src/services/knowledge/search.ts` — query → embed → knn.
- `packages/core/src/services/knowledge/index.ts` — `KnowledgeService` façade.
- `packages/mcp-server/src/tools/knowledge.ts` — mcp tool parity.
- Tests under each package's `tests/` mirroring the above.

**Modify:**
- `packages/core/src/config.ts` — add `KnowledgeConfig` + env.
- `packages/core/src/runtime.ts` — add `knowledge` to `McpRuntime`.
- `packages/core/src/index.ts` — export new modules.
- `packages/core/package.json` — add deps.
- `packages/sre-agent/src/tools/index.ts` — add `search_knowledge`, `index_url`.
- `packages/sre-agent/src/cli/index.ts` — add `crawl` subcommand + doctor checks.
- `packages/mcp-server/src/tools/index.ts` — register knowledge tools.
- `packages/sre-agent/.env.example` + `packages/sre-agent/README.md` — document crawl env.

---

## Task 1: Add dependencies to `@sre/core`

**Files:**
- Modify: `packages/core/package.json`

- [ ] **Step 1: Add the runtime deps**

Edit `packages/core/package.json` `dependencies` to:

```json
"dependencies": {
  "@mozilla/readability": "^0.5.0",
  "better-sqlite3": "^11.8.0",
  "linkedom": "^0.18.5",
  "sqlite-vec": "^0.1.6",
  "undici": "^6.27.0",
  "zod": "^3.24.0"
}
```

Add dev type deps to `devDependencies` (create the block if absent):

```json
"devDependencies": {
  "@types/better-sqlite3": "^7.6.11"
}
```

- [ ] **Step 2: Install from repo root**

Run: `npm install`
Expected: installs without error; `better-sqlite3` compiles or fetches a prebuilt binary for the platform.

- [ ] **Step 3: Verify sqlite-vec loads**

Run:
```bash
node -e "const D=require('better-sqlite3');const v=require('sqlite-vec');const db=new D(':memory:');v.load(db);console.log(db.prepare('select vec_version() v').get())"
```
Expected: prints `{ v: 'v0.1.6' }` (or similar version string), no error.

- [ ] **Step 4: Commit**

```bash
git add packages/core/package.json package-lock.json
git commit -m "build(core): add crawler + sqlite-vec deps"
```

---

## Task 2: Knowledge config in `@sre/core`

**Files:**
- Modify: `packages/core/src/config.ts`
- Test: `packages/core/tests/config.knowledge.test.ts` (create `tests/` dir if absent)

- [ ] **Step 1: Write the failing test**

Create `packages/core/tests/config.knowledge.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

const base = {
  SERVICENOW_BASE_URL: "https://x.service-now.com",
  SERVICENOW_USERNAME: "u",
  SERVICENOW_PASSWORD: "p"
};

describe("knowledge config", () => {
  it("applies defaults", () => {
    const c = loadConfig(base);
    expect(c.knowledge.maxPages).toBe(200);
    expect(c.knowledge.maxDepth).toBe(3);
    expect(c.knowledge.embedModel).toBe("nomic-embed-text");
    expect(c.knowledge.embedBaseUrl).toBe("http://localhost:11434/v1");
    expect(c.knowledge.respectRobots).toBe(true);
    expect(c.knowledge.seeds).toEqual([]);
  });

  it("parses seeds + derives allowDomains from seed hosts", () => {
    const c = loadConfig({ ...base, CRAWL_SEEDS: "https://wiki.acme.io/a, https://kb.acme.io/b" });
    expect(c.knowledge.seeds).toEqual(["https://wiki.acme.io/a", "https://kb.acme.io/b"]);
    expect(c.knowledge.allowDomains).toEqual(["wiki.acme.io", "kb.acme.io"]);
  });

  it("embedBaseUrl falls back to LLM_BASE_URL", () => {
    const c = loadConfig({ ...base, LLM_BASE_URL: "http://ollama:11434/v1" });
    expect(c.knowledge.embedBaseUrl).toBe("http://ollama:11434/v1");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project core config.knowledge`
Expected: FAIL — `c.knowledge` is undefined.

- [ ] **Step 3: Implement config**

In `packages/core/src/config.ts`, add to `envSchema` (inside the `z.object({...})`):

```ts
  KNOWLEDGE_DB_PATH: z.string().optional(),
  CRAWL_SEEDS: z.string().optional(),
  CRAWL_ALLOW_DOMAINS: z.string().optional(),
  CRAWL_MAX_PAGES: z.coerce.number().int().positive().default(200),
  CRAWL_MAX_DEPTH: z.coerce.number().int().nonnegative().default(3),
  CRAWL_CONCURRENCY: z.coerce.number().int().positive().default(4),
  CRAWL_RATE_MS: z.coerce.number().int().nonnegative().default(500),
  CRAWL_MAX_BYTES: z.coerce.number().int().positive().default(2097152),
  CRAWL_PROXY: optionalUrl,
  CRAWL_RESPECT_ROBOTS: trueBoolString,
  CRAWL_TOPIC: optional(z.string().min(1)),
  EMBED_MODEL: z.string().default("nomic-embed-text"),
  EMBED_BASE_URL: optional(z.string().url()),
  LLM_BASE_URL: optional(z.string().url()),
  CRAWL_LLM_MODEL: z.string().default("qwen2.5")
```

Add the `KnowledgeConfig` interface (after `AdoConfig`):

```ts
export interface KnowledgeConfig {
  dbPath: string;
  seeds: string[];
  allowDomains: string[];
  maxPages: number;
  maxDepth: number;
  concurrency: number;
  rateMs: number;
  maxBytes: number;
  proxyUrl?: string;
  respectRobots: boolean;
  topic?: string;
  embedModel: string;
  embedBaseUrl: string;
  crawlModel: string;
}
```

Add `knowledge: KnowledgeConfig;` to the `AppConfig` interface.

Add this helper above `loadConfig`:

```ts
import { homedir } from "node:os";
import { join } from "node:path";

const csv = (v?: string): string[] =>
  (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const hostOf = (u: string): string | undefined => {
  try {
    return new URL(u).host;
  } catch {
    return undefined;
  }
};
```

In `loadConfig`, before the final `return`, build the knowledge block, and add `knowledge` to the returned object:

```ts
  const seeds = csv(e.CRAWL_SEEDS);
  const allowDomains =
    csv(e.CRAWL_ALLOW_DOMAINS).length > 0
      ? csv(e.CRAWL_ALLOW_DOMAINS)
      : [...new Set(seeds.map(hostOf).filter((h): h is string => !!h))];
  const knowledge: KnowledgeConfig = {
    dbPath: e.KNOWLEDGE_DB_PATH || join(homedir(), ".sre-agent", "knowledge.db"),
    seeds,
    allowDomains,
    maxPages: e.CRAWL_MAX_PAGES,
    maxDepth: e.CRAWL_MAX_DEPTH,
    concurrency: e.CRAWL_CONCURRENCY,
    rateMs: e.CRAWL_RATE_MS,
    maxBytes: e.CRAWL_MAX_BYTES,
    proxyUrl: e.CRAWL_PROXY,
    respectRobots: e.CRAWL_RESPECT_ROBOTS,
    topic: e.CRAWL_TOPIC,
    embedModel: e.EMBED_MODEL,
    embedBaseUrl: e.EMBED_BASE_URL || e.LLM_BASE_URL || "http://localhost:11434/v1",
    crawlModel: e.CRAWL_LLM_MODEL
  };
```

Add `knowledge,` to the object returned by `loadConfig`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project core config.knowledge`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/config.ts packages/core/tests/config.knowledge.test.ts
git commit -m "feat(core): knowledge/crawl config block"
```

---

## Task 3: Shared knowledge types

**Files:**
- Create: `packages/core/src/services/knowledge/types.ts`

- [ ] **Step 1: Create the types (no test — pure declarations)**

Create `packages/core/src/services/knowledge/types.ts`:

```ts
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
```

- [ ] **Step 2: Commit**

```bash
git add packages/core/src/services/knowledge/types.ts
git commit -m "feat(core): knowledge shared types"
```

---

## Task 4: LLM client (Ollama chat + embed)

**Files:**
- Create: `packages/core/src/clients/llm.ts`
- Test: `packages/core/tests/llm.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/tests/llm.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import * as undici from "undici";
import { OllamaClient } from "../src/clients/llm.js";

afterEach(() => vi.restoreAllMocks());

describe("OllamaClient", () => {
  it("chat posts to /chat/completions and returns content", async () => {
    const spy = vi.spyOn(undici, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "hello" } }] })
    } as any);
    const c = new OllamaClient({ baseUrl: "http://h/v1", chatModel: "m", embedModel: "e" });
    const out = await c.chat("hi");
    expect(out).toBe("hello");
    expect(spy.mock.calls[0][0]).toBe("http://h/v1/chat/completions");
  });

  it("embed posts to /embeddings and returns the vector", async () => {
    vi.spyOn(undici, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] })
    } as any);
    const c = new OllamaClient({ baseUrl: "http://h/v1", chatModel: "m", embedModel: "e" });
    expect(await c.embed("x")).toEqual([0.1, 0.2, 0.3]);
  });

  it("throws on non-ok response", async () => {
    vi.spyOn(undici, "fetch").mockResolvedValue({ ok: false, status: 500, text: async () => "boom" } as any);
    const c = new OllamaClient({ baseUrl: "http://h/v1", chatModel: "m", embedModel: "e" });
    await expect(c.chat("hi")).rejects.toThrow(/500/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project core llm`
Expected: FAIL — cannot find `../src/clients/llm.js`.

- [ ] **Step 3: Implement**

Create `packages/core/src/clients/llm.ts`:

```ts
import { fetch } from "undici";
import { proxyDispatcher, FetchDispatcher } from "./proxy.js";
import type { LlmClient } from "../services/knowledge/types.js";

export interface OllamaOptions {
  baseUrl: string; // includes /v1
  chatModel: string;
  embedModel: string;
  apiKey?: string; // optional; Ollama ignores it
  proxyUrl?: string;
}

/**
 * Minimal OpenAI-compatible client for the crawl pipeline. Talks directly to
 * the Ollama endpoint (NOT through the Copilot SDK) because crawl/CLI ingest
 * runs outside any Copilot session.
 */
export class OllamaClient implements LlmClient {
  private readonly dispatcher?: FetchDispatcher;
  constructor(private readonly opts: OllamaOptions) {
    this.dispatcher = proxyDispatcher(opts.proxyUrl);
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.opts.apiKey) h.authorization = `Bearer ${this.opts.apiKey}`;
    return h;
  }

  async chat(prompt: string): Promise<string> {
    const res = await fetch(`${this.opts.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      dispatcher: this.dispatcher,
      body: JSON.stringify({
        model: this.opts.chatModel,
        messages: [{ role: "user", content: prompt }],
        stream: false,
        temperature: 0
      })
    });
    if (!res.ok) throw new Error(`chat failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? "";
  }

  async embed(text: string): Promise<number[]> {
    const res = await fetch(`${this.opts.baseUrl}/embeddings`, {
      method: "POST",
      headers: this.headers(),
      dispatcher: this.dispatcher,
      body: JSON.stringify({ model: this.opts.embedModel, input: text })
    });
    if (!res.ok) throw new Error(`embed failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { data?: { embedding?: number[] }[] };
    const vec = data.data?.[0]?.embedding;
    if (!vec) throw new Error("embed failed: no embedding in response");
    return vec;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project core llm`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/clients/llm.ts packages/core/tests/llm.test.ts
git commit -m "feat(core): Ollama chat+embed client"
```

---

## Task 5: HTML extractor

**Files:**
- Create: `packages/core/src/clients/crawler/extract.ts`
- Test: `packages/core/tests/extract.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/tests/extract.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { extractPage } from "../src/clients/crawler/extract.js";

const html = `<!doctype html><html><head><title>Runbook: Restart</title></head>
<body>
  <nav><a href="/login">Login</a></nav>
  <article><h1>Restart Service</h1><p>Step one. Step two with enough words to be real content here.</p>
  <a href="/runbooks/db">DB runbook</a><a href="https://other.io/x">external</a></article>
</body></html>`;

describe("extractPage", () => {
  it("extracts title, main text and resolves absolute links", () => {
    const doc = extractPage(html, "https://wiki.acme.io/runbooks/restart");
    expect(doc.title).toContain("Restart");
    expect(doc.mainText).toContain("Step one");
    expect(doc.links).toContain("https://wiki.acme.io/runbooks/db");
    expect(doc.links).toContain("https://wiki.acme.io/login");
    expect(doc.links).toContain("https://other.io/x");
  });

  it("dedupes links and drops non-http(s) schemes", () => {
    const doc = extractPage(
      `<a href="mailto:x@y.z">m</a><a href="/a">a</a><a href="/a">a2</a>`,
      "https://h/p"
    );
    expect(doc.links.filter((l) => l === "https://h/a")).toHaveLength(1);
    expect(doc.links.some((l) => l.startsWith("mailto"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project core extract`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement**

Create `packages/core/src/clients/crawler/extract.ts`:

```ts
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import type { PageDoc } from "../../services/knowledge/types.js";

/** Resolve an href against base; return undefined unless it's http(s). */
const absolutize = (href: string, base: string): string | undefined => {
  try {
    const u = new URL(href, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    u.hash = "";
    return u.toString();
  } catch {
    return undefined;
  }
};

/**
 * Parse HTML into clean main text + resolved outbound links.
 * Readability gives the salient article text; we still harvest links from the
 * full DOM (Readability strips most nav links we'd want as crawl frontier).
 */
export const extractPage = (html: string, baseUrl: string): PageDoc => {
  const { document } = parseHTML(html);

  const links = [
    ...new Set(
      [...document.querySelectorAll("a[href]")]
        .map((a) => absolutize(a.getAttribute("href") ?? "", baseUrl))
        .filter((l): l is string => !!l)
    )
  ];

  let title = document.querySelector("title")?.textContent?.trim() || undefined;
  let mainText = "";
  try {
    const parsed = new Readability(document as any).parse();
    if (parsed) {
      title = parsed.title?.trim() || title;
      mainText = (parsed.textContent ?? "").replace(/\s+\n/g, "\n").replace(/[ \t]{2,}/g, " ").trim();
    }
  } catch {
    // Readability can throw on malformed DOM; fall back to body text.
  }
  if (!mainText) mainText = (document.body?.textContent ?? "").replace(/\s{2,}/g, " ").trim();

  return { title, mainText, links };
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project core extract`
Expected: PASS (2 tests). If Readability returns null for the tiny fixture, the body-text fallback still satisfies the assertions.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/clients/crawler/extract.ts packages/core/tests/extract.test.ts
git commit -m "feat(core): HTML content + link extractor"
```

---

## Task 6: Chunker

**Files:**
- Create: `packages/core/src/services/knowledge/chunk.ts`
- Test: `packages/core/tests/chunk.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/tests/chunk.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { chunkText } from "../src/services/knowledge/chunk.js";

describe("chunkText", () => {
  it("returns one chunk for short text", () => {
    expect(chunkText("hello world", 100, 10)).toEqual(["hello world"]);
  });

  it("splits long text with overlap and never exceeds size", () => {
    const text = "a".repeat(250);
    const chunks = chunkText(text, 100, 20);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100);
  });

  it("drops empty/whitespace-only input", () => {
    expect(chunkText("   \n  ", 100, 10)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project core chunk`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement**

Create `packages/core/src/services/knowledge/chunk.ts`:

```ts
/**
 * Split text into ~size-char chunks with `overlap`-char carryover between them.
 * Splits on paragraph boundaries when possible, falling back to hard slicing
 * for oversized paragraphs. Character-based (not token-based) to stay dep-free;
 * size defaults are chosen to sit comfortably under the embed model's limit.
 */
export const chunkText = (text: string, size = 1200, overlap = 200): string[] => {
  const clean = text.trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];

  const paras = clean.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let buf = "";
  const flush = () => {
    if (buf.trim()) chunks.push(buf.trim());
    buf = buf.length > overlap ? buf.slice(buf.length - overlap) : "";
  };

  for (const para of paras) {
    if (para.length > size) {
      if (buf.trim()) flush();
      for (let i = 0; i < para.length; i += size - overlap) {
        chunks.push(para.slice(i, i + size));
      }
      buf = "";
      continue;
    }
    if (buf.length + para.length + 2 > size) flush();
    buf += (buf ? "\n\n" : "") + para;
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks;
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project core chunk`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/services/knowledge/chunk.ts packages/core/tests/chunk.test.ts
git commit -m "feat(core): text chunker"
```

---

## Task 7: robots.txt check

**Files:**
- Create: `packages/core/src/clients/crawler/robots.ts`
- Test: `packages/core/tests/robots.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/tests/robots.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { isAllowed } from "../src/clients/crawler/robots.js";

const robots = `User-agent: *
Disallow: /private
Disallow: /admin
`;

describe("isAllowed", () => {
  it("allows paths not disallowed", () => {
    expect(isAllowed(robots, "/runbooks/db")).toBe(true);
  });
  it("blocks disallowed prefixes", () => {
    expect(isAllowed(robots, "/private/x")).toBe(false);
    expect(isAllowed(robots, "/admin")).toBe(false);
  });
  it("allows everything when robots is empty", () => {
    expect(isAllowed("", "/anything")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project core robots`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement**

Create `packages/core/src/clients/crawler/robots.ts`:

```ts
/**
 * Minimal robots.txt evaluator for `User-agent: *` Disallow rules. Good enough
 * for internal sites; not a full RFC 9309 implementation (no Allow-precedence,
 * no wildcards). Returns true (allowed) when no matching disallow rule exists.
 */
export const isAllowed = (robotsTxt: string, path: string): boolean => {
  if (!robotsTxt.trim()) return true;
  let appliesToAll = false;
  const disallows: string[] = [];
  for (const raw of robotsTxt.split("\n")) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const [field, ...rest] = line.split(":");
    const value = rest.join(":").trim();
    const key = field.trim().toLowerCase();
    if (key === "user-agent") appliesToAll = value === "*";
    else if (key === "disallow" && appliesToAll && value) disallows.push(value);
  }
  return !disallows.some((d) => path.startsWith(d));
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project core robots`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/clients/crawler/robots.ts packages/core/tests/robots.test.ts
git commit -m "feat(core): minimal robots.txt check"
```

---

## Task 8: Fetcher

**Files:**
- Create: `packages/core/src/clients/crawler/fetcher.ts`
- Test: `packages/core/tests/fetcher.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/tests/fetcher.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import * as undici from "undici";
import { Fetcher } from "../src/clients/crawler/fetcher.js";

afterEach(() => vi.restoreAllMocks());

const res = (over: Partial<{ status: number; ct: string; body: string }>) => ({
  ok: (over.status ?? 200) < 400,
  status: over.status ?? 200,
  headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? over.ct ?? "text/html" : null) },
  text: async () => over.body ?? "<html></html>"
});

describe("Fetcher", () => {
  it("returns body for html", async () => {
    vi.spyOn(undici, "fetch").mockResolvedValue(res({ body: "<h1>ok</h1>" }) as any);
    const f = new Fetcher({ maxBytes: 1000 });
    const r = await f.get("https://h/p");
    expect(r.ok).toBe(true);
    expect(r.body).toContain("ok");
  });

  it("skips non-html content types", async () => {
    vi.spyOn(undici, "fetch").mockResolvedValue(res({ ct: "application/pdf" }) as any);
    const f = new Fetcher({ maxBytes: 1000 });
    const r = await f.get("https://h/p.pdf");
    expect(r.ok).toBe(false);
    expect(r.body).toBe("");
  });

  it("marks oversized bodies not-ok", async () => {
    vi.spyOn(undici, "fetch").mockResolvedValue(res({ body: "x".repeat(2000) }) as any);
    const f = new Fetcher({ maxBytes: 1000 });
    const r = await f.get("https://h/big");
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project core fetcher`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement**

Create `packages/core/src/clients/crawler/fetcher.ts`:

```ts
import { fetch } from "undici";
import { proxyDispatcher, FetchDispatcher } from "../proxy.js";
import type { FetchResult } from "../../services/knowledge/types.js";

export interface FetcherOptions {
  maxBytes: number;
  proxyUrl?: string;
  timeoutMs?: number;
}

export class Fetcher {
  private readonly dispatcher?: FetchDispatcher;
  constructor(private readonly opts: FetcherOptions) {
    this.dispatcher = proxyDispatcher(opts.proxyUrl);
  }

  async get(url: string): Promise<FetchResult> {
    const empty = (status: number, ct = ""): FetchResult => ({ ok: false, status, contentType: ct, body: "" });
    try {
      const res = await fetch(url, {
        method: "GET",
        dispatcher: this.dispatcher,
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15000),
        headers: { "user-agent": "sre-agent-crawler/1.0" }
      });
      const ct = res.headers.get("content-type") ?? "";
      if (!res.ok) return empty(res.status, ct);
      if (!ct.includes("text/html")) return empty(res.status, ct);
      const body = await res.text();
      if (body.length > this.opts.maxBytes) return empty(res.status, ct);
      return { ok: true, status: res.status, contentType: ct, body };
    } catch {
      return empty(0);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project core fetcher`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/clients/crawler/fetcher.ts packages/core/tests/fetcher.test.ts
git commit -m "feat(core): crawler HTTP fetcher with guards"
```

---

## Task 9: sqlite-vec store

**Files:**
- Create: `packages/core/src/services/knowledge/store.ts`
- Test: `packages/core/tests/store.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/tests/store.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { KnowledgeStore } from "../src/services/knowledge/store.js";

const vec = (a: number, b: number, c: number) => [a, b, c];

describe("KnowledgeStore", () => {
  it("upserts a page + chunks and finds them by knn", () => {
    const s = new KnowledgeStore(":memory:", { model: "e", dim: 3 });
    s.upsertPage({
      url: "https://h/a",
      title: "A",
      hash: "h1",
      crawledAt: 1,
      indexed: true,
      chunks: [
        { ord: 0, text: "alpha", embedding: vec(1, 0, 0) },
        { ord: 1, text: "beta", embedding: vec(0, 1, 0) }
      ]
    });
    const hits = s.knn(vec(0.9, 0.1, 0), 1);
    expect(hits).toHaveLength(1);
    expect(hits[0].text).toBe("alpha");
    expect(hits[0].url).toBe("https://h/a");
    s.close();
  });

  it("re-upsert replaces a page's chunks (no stale rows)", () => {
    const s = new KnowledgeStore(":memory:", { model: "e", dim: 3 });
    const page = (text: string, emb: number[]) => ({
      url: "https://h/a", title: "A", hash: "h", crawledAt: 1, indexed: true,
      chunks: [{ ord: 0, text, embedding: emb }]
    });
    s.upsertPage(page("old", vec(1, 0, 0)));
    s.upsertPage(page("new", vec(1, 0, 0)));
    expect(s.stats().chunks).toBe(1);
    expect(s.knn(vec(1, 0, 0), 1)[0].text).toBe("new");
    s.close();
  });

  it("getPageHash returns the stored hash for incremental crawl", () => {
    const s = new KnowledgeStore(":memory:", { model: "e", dim: 3 });
    s.upsertPage({ url: "https://h/a", hash: "abc", crawledAt: 1, indexed: false, chunks: [] });
    expect(s.getPageHash("https://h/a")).toBe("abc");
    expect(s.getPageHash("https://h/missing")).toBeUndefined();
    s.close();
  });

  it("rejects a dim mismatch against the stored model", () => {
    const s = new KnowledgeStore(":memory:", { model: "e", dim: 3 });
    expect(() => s.knn([1, 2], 1)).toThrow(/dim/i);
    s.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project core store`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement**

Create `packages/core/src/services/knowledge/store.ts`:

```ts
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import type { SearchHit, KnowledgeStats } from "./types.js";

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
        insVec.run(info.lastInsertRowid as number, f32(c.embedding));
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

  knn(query: number[], k: number, domain?: string): SearchHit[] {
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
        snippet: r.text.slice(0, 400),
        score: 1 / (1 + r.distance)
      }));
  }

  stats(): KnowledgeStats {
    const pages = (this.db.prepare("SELECT COUNT(*) n FROM pages").get() as { n: number }).n;
    const chunks = (this.db.prepare("SELECT COUNT(*) n FROM chunks").get() as { n: number }).n;
    const last = this.db.prepare("SELECT MAX(crawled_at) m FROM pages").get() as { m: number | null };
    return { pages, chunks, lastCrawl: last.m ?? undefined, model: this.model, dim: this.dim };
  }

  close(): void {
    this.db.close();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project core store`
Expected: PASS (4 tests). Note: domain filter on `knn` uses an exact host match.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/services/knowledge/store.ts packages/core/tests/store.test.ts
git commit -m "feat(core): sqlite-vec knowledge store"
```

---

## Task 10: Crawl verdict parser

**Files:**
- Create: `packages/core/src/services/knowledge/verdict.ts`
- Test: `packages/core/tests/verdict.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/tests/verdict.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseVerdict, buildVerdictPrompt } from "../src/services/knowledge/verdict.js";

describe("parseVerdict", () => {
  it("parses clean json", () => {
    expect(parseVerdict('{"relevant":true,"keepLinks":["https://h/a"]}')).toEqual({
      relevant: true, keepLinks: ["https://h/a"]
    });
  });
  it("extracts json embedded in prose / fences", () => {
    const v = parseVerdict('Sure!\n```json\n{"relevant": false, "keepLinks": []}\n```');
    expect(v.relevant).toBe(false);
    expect(v.keepLinks).toEqual([]);
  });
  it("defaults to keep on unparseable output (fail-soft)", () => {
    const v = parseVerdict("the model rambled with no json");
    expect(v.relevant).toBe(true);
    expect(v.keepLinks).toEqual([]);
  });
});

describe("buildVerdictPrompt", () => {
  it("includes topic, title and capped links", () => {
    const p = buildVerdictPrompt("incident runbooks", "T", "body text", ["https://h/a", "https://h/b"], 1);
    expect(p).toContain("incident runbooks");
    expect(p).toContain("https://h/a");
    expect(p).not.toContain("https://h/b"); // capped to 1
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project core verdict`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement**

Create `packages/core/src/services/knowledge/verdict.ts`:

```ts
import type { CrawlVerdict } from "./types.js";

/**
 * Build the single combined relevance + link-keep prompt. Keeping it one call
 * per page halves crawl LLM cost vs separate relevance/link calls.
 */
export const buildVerdictPrompt = (
  topic: string | undefined,
  title: string | undefined,
  bodyHead: string,
  links: string[],
  maxLinks: number
): string => {
  const scope = topic ? `The crawl topic is: "${topic}".` : "The goal is to collect useful internal documentation.";
  const linkList = links.slice(0, maxLinks).map((l, i) => `${i + 1}. ${l}`).join("\n");
  return [
    `${scope}`,
    `Decide (1) whether THIS page is worth indexing, and (2) which of its links are worth following.`,
    ``,
    `PAGE TITLE: ${title ?? "(none)"}`,
    `PAGE TEXT (truncated):`,
    bodyHead,
    ``,
    `LINKS:`,
    linkList || "(none)",
    ``,
    `Respond with STRICT JSON only, no prose:`,
    `{"relevant": <true|false>, "keepLinks": [<urls to follow, copied verbatim from LINKS>]}`
  ].join("\n");
};

/** Parse the model's JSON verdict; fail-soft to keep-but-no-links. */
export const parseVerdict = (raw: string): CrawlVerdict => {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const obj = JSON.parse(raw.slice(start, end + 1));
      return {
        relevant: typeof obj.relevant === "boolean" ? obj.relevant : true,
        keepLinks: Array.isArray(obj.keepLinks) ? obj.keepLinks.filter((x: unknown) => typeof x === "string") : []
      };
    } catch {
      /* fall through */
    }
  }
  return { relevant: true, keepLinks: [] };
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project core verdict`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/services/knowledge/verdict.ts packages/core/tests/verdict.test.ts
git commit -m "feat(core): crawl verdict prompt + parser"
```

---

## Task 11: Crawl orchestrator

**Files:**
- Create: `packages/core/src/services/knowledge/crawl.ts`
- Test: `packages/core/tests/crawl.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/tests/crawl.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { crawl, type CrawlDeps } from "../src/services/knowledge/crawl.js";

// Fake link graph: seed -> /a (relevant) -> /b (relevant); /a also links offsite + /a again.
const pages: Record<string, { html: string }> = {
  "https://h/seed": { html: "seed" },
  "https://h/a": { html: "a" },
  "https://h/b": { html: "b" }
};

const makeDeps = (over: Partial<CrawlDeps> = {}): CrawlDeps => {
  const upserts: string[] = [];
  return {
    fetcher: { get: vi.fn(async (url: string) => ({ ok: !!pages[url], status: pages[url] ? 200 : 404, contentType: "text/html", body: pages[url]?.html ?? "" })) },
    extract: (_html: string, url: string) => ({
      title: url,
      mainText: `text of ${url}`,
      links: url === "https://h/seed" ? ["https://h/a", "https://other/x"] : url === "https://h/a" ? ["https://h/b", "https://h/a"] : []
    }),
    llm: {
      chat: vi.fn(async () => JSON.stringify({ relevant: true, keepLinks: ["https://h/a", "https://h/b", "https://other/x"] })),
      embed: vi.fn(async () => [1, 0, 0])
    },
    store: {
      getPageHash: vi.fn(() => undefined),
      upsertPage: vi.fn((p: any) => { upserts.push(p.url); }),
      stats: () => ({ pages: upserts.length, chunks: upserts.length })
    } as any,
    robots: { fetchAndCheck: vi.fn(async () => true) },
    now: () => 1,
    log: () => {},
    ...over
  };
};

describe("crawl", () => {
  it("stays within allowed domains and respects max pages", async () => {
    const deps = makeDeps();
    const res = await crawl(deps, {
      seeds: ["https://h/seed"], allowDomains: ["h"], maxPages: 10, maxDepth: 3,
      concurrency: 1, rateMs: 0, maxLinksPerPage: 50
    });
    const fetched = (deps.fetcher.get as any).mock.calls.map((c: any[]) => c[0]);
    expect(fetched).toContain("https://h/seed");
    expect(fetched).toContain("https://h/a");
    expect(fetched).toContain("https://h/b");
    expect(fetched).not.toContain("https://other/x"); // out of scope
    expect(res.pagesCrawled).toBe(3);
  });

  it("dedupes already-seen urls", async () => {
    const deps = makeDeps();
    await crawl(deps, { seeds: ["https://h/seed"], allowDomains: ["h"], maxPages: 10, maxDepth: 3, concurrency: 1, rateMs: 0, maxLinksPerPage: 50 });
    const fetched = (deps.fetcher.get as any).mock.calls.map((c: any[]) => c[0]);
    expect(fetched.filter((u: string) => u === "https://h/a")).toHaveLength(1);
  });

  it("skips re-embed when hash unchanged", async () => {
    const deps = makeDeps({
      store: {
        getPageHash: vi.fn(() => "SAME"),
        upsertPage: vi.fn(),
        stats: () => ({ pages: 0, chunks: 0 })
      } as any
    });
    // Force extract to a stable text so the hash matches what getPageHash returns.
    deps.extract = (_h, _u) => ({ title: "t", mainText: "SAME", links: [] });
    // hashOf is sha256; pre-seed store to return that exact hash:
    const { sha256 } = await import("../src/services/knowledge/crawl.js");
    (deps.store.getPageHash as any).mockReturnValue(sha256("SAME"));
    await crawl(deps, { seeds: ["https://h/seed"], allowDomains: ["h"], maxPages: 10, maxDepth: 0, concurrency: 1, rateMs: 0, maxLinksPerPage: 50 });
    expect(deps.store.upsertPage).not.toHaveBeenCalled();
  });

  it("respects maxDepth (depth 0 fetches only seeds)", async () => {
    const deps = makeDeps();
    await crawl(deps, { seeds: ["https://h/seed"], allowDomains: ["h"], maxPages: 10, maxDepth: 0, concurrency: 1, rateMs: 0, maxLinksPerPage: 50 });
    const fetched = (deps.fetcher.get as any).mock.calls.map((c: any[]) => c[0]);
    expect(fetched).toEqual(["https://h/seed"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project core crawl`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement**

Create `packages/core/src/services/knowledge/crawl.ts`:

```ts
import { createHash } from "node:crypto";
import type { FetchResult, LlmClient, PageDoc } from "./types.js";
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
  llm: LlmClient;
  store: Pick<KnowledgeStore, "getPageHash" | "upsertPage" | "stats">;
  robots: { fetchAndCheck(url: string): Promise<boolean> };
  now: () => number;
  log: (msg: string) => void;
}

export interface CrawlResult {
  pagesCrawled: number;
  pagesIndexed: number;
  pagesSkipped: number;
  dropped: number; // links not followed because a cap was hit
}

const canonical = (url: string): string => {
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

const inScope = (url: string, allow: string[]): boolean => {
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
    if (!seen.has(c)) { seen.add(c); queue.push({ url: c, depth: 0 }); }
  }

  const result: CrawlResult = { pagesCrawled: 0, pagesIndexed: 0, pagesSkipped: 0, dropped: 0 };

  while (queue.length > 0) {
    if (result.pagesCrawled >= bounds.maxPages) {
      result.dropped += queue.length;
      deps.log(`[crawl] page cap ${bounds.maxPages} hit; dropping ${queue.length} queued URLs`);
      break;
    }
    const { url, depth } = queue.shift()!;

    if (!(await deps.robots.fetchAndCheck(url))) { deps.log(`[crawl] robots disallow ${url}`); continue; }

    const res = await deps.fetcher.get(url);
    if (!res.ok) { deps.log(`[crawl] skip ${url} (status ${res.status})`); continue; }
    result.pagesCrawled++;

    const doc = deps.extract(res.body, url);
    if (!doc.mainText) { result.pagesSkipped++; continue; }

    const hash = sha256(doc.mainText);
    const unchanged = deps.store.getPageHash(url) === hash;

    // Combined relevance + link-keep verdict.
    const prompt = buildVerdictPrompt(bounds.topic, doc.title, doc.mainText.slice(0, 2000), doc.links, bounds.maxLinksPerPage);
    let verdict;
    try {
      verdict = parseVerdict(await deps.llm.chat(prompt));
    } catch (e) {
      deps.log(`[crawl] verdict failed for ${url}; keeping page, no links: ${String(e)}`);
      verdict = { relevant: true, keepLinks: [] as string[] };
    }

    // Index (unless unchanged — incremental skip).
    if (verdict.relevant && !unchanged) {
      try {
        const chunks = chunkText(doc.mainText);
        const embedded = [];
        for (let i = 0; i < chunks.length; i++) {
          embedded.push({ ord: i, text: chunks[i], embedding: await deps.llm.embed(chunks[i]) });
        }
        deps.store.upsertPage({ url, title: doc.title, hash, crawledAt: deps.now(), indexed: true, chunks: embedded });
        result.pagesIndexed++;
      } catch (e) {
        deps.log(`[crawl] embed/store failed for ${url}: ${String(e)}`);
        deps.store.upsertPage({ url, title: doc.title, hash, crawledAt: deps.now(), indexed: false, chunks: [] });
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
        if (seen.size >= bounds.maxPages) { result.dropped++; continue; }
        seen.add(c);
        queue.push({ url: c, depth: depth + 1 });
      }
    }

    await sleep(bounds.rateMs);
  }

  deps.log(`[crawl] done: ${JSON.stringify(result)}`);
  return result;
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project core crawl`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/services/knowledge/crawl.ts packages/core/tests/crawl.test.ts
git commit -m "feat(core): LLM-guided BFS crawl orchestrator"
```

---

## Task 12: Search + robots fetcher + KnowledgeService façade

**Files:**
- Create: `packages/core/src/services/knowledge/search.ts`
- Create: `packages/core/src/clients/crawler/robotsClient.ts`
- Create: `packages/core/src/services/knowledge/index.ts`
- Test: `packages/core/tests/search.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/tests/search.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { search } from "../src/services/knowledge/search.js";

describe("search", () => {
  it("embeds the query and returns store hits", async () => {
    const llm = { embed: vi.fn(async () => [1, 0, 0]), chat: vi.fn() };
    const store = { knn: vi.fn(() => [{ url: "https://h/a", title: "A", snippet: "alpha", score: 0.9 }]) };
    const res = await search({ llm, store } as any, "how to restart", 3);
    expect(llm.embed).toHaveBeenCalledWith("how to restart");
    expect(store.knn).toHaveBeenCalledWith([1, 0, 0], 3, undefined);
    expect(res.count).toBe(1);
    expect(res.results[0].url).toBe("https://h/a");
  });

  it("returns a hint when the index is empty", async () => {
    const llm = { embed: vi.fn(async () => [1, 0, 0]), chat: vi.fn() };
    const store = { knn: vi.fn(() => []) };
    const res = await search({ llm, store } as any, "x", 3);
    expect(res.count).toBe(0);
    expect(res.hint).toMatch(/crawl/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project core search`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement search**

Create `packages/core/src/services/knowledge/search.ts`:

```ts
import type { LlmClient, SearchHit } from "./types.js";
import type { KnowledgeStore } from "./store.js";

export interface SearchResponse {
  count: number;
  results: SearchHit[];
  hint?: string;
}

export const search = async (
  deps: { llm: Pick<LlmClient, "embed">; store: Pick<KnowledgeStore, "knn"> },
  query: string,
  k = 6,
  domain?: string
): Promise<SearchResponse> => {
  const vec = await deps.llm.embed(query);
  const results = deps.store.knn(vec, Math.min(Math.max(k, 1), 20), domain);
  return {
    count: results.length,
    results,
    hint: results.length === 0 ? "index empty or no match — run `sre-agent crawl` to populate it" : undefined
  };
};
```

- [ ] **Step 4: Implement the robots client**

Create `packages/core/src/clients/crawler/robotsClient.ts`:

```ts
import { Fetcher } from "./fetcher.js";
import { isAllowed } from "./robots.js";

/**
 * Fetches and caches robots.txt per host, then evaluates a URL's path.
 * When CRAWL_RESPECT_ROBOTS is false the caller should not use this at all.
 */
export class RobotsClient {
  private readonly cache = new Map<string, string>();
  constructor(private readonly fetcher: Fetcher, private readonly enabled: boolean) {}

  async fetchAndCheck(url: string): Promise<boolean> {
    if (!this.enabled) return true;
    let origin: string, path: string;
    try {
      const u = new URL(url);
      origin = u.origin;
      path = u.pathname;
    } catch {
      return true;
    }
    if (!this.cache.has(origin)) {
      const res = await this.fetcher.get(`${origin}/robots.txt`);
      // Non-html robots often returns text/plain → fetcher returns ok:false for
      // non-html, so fall back to res.body which is "" → treat as allow-all.
      this.cache.set(origin, res.body ?? "");
    }
    return isAllowed(this.cache.get(origin) ?? "", path);
  }
}
```

Note: `Fetcher` only returns a body for `text/html`. For robots.txt (text/plain) it returns `body: ""`, which `isAllowed` treats as allow-all. If strict robots parsing is needed later, add a raw-text fetch path to `Fetcher`; out of scope for v1.

- [ ] **Step 5: Implement the façade**

Create `packages/core/src/services/knowledge/index.ts`:

```ts
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
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run --project core search`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/services/knowledge/search.ts packages/core/src/clients/crawler/robotsClient.ts packages/core/src/services/knowledge/index.ts packages/core/tests/search.test.ts
git commit -m "feat(core): search, robots client, KnowledgeService facade"
```

---

## Task 13: Wire `KnowledgeService` into the runtime + exports

**Files:**
- Modify: `packages/core/src/runtime.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/tests/runtime.knowledge.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/tests/runtime.knowledge.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createMcpRuntime } from "../src/runtime.js";

const env = {
  SERVICENOW_BASE_URL: "https://x.service-now.com",
  SERVICENOW_USERNAME: "u",
  SERVICENOW_PASSWORD: "p"
};

describe("runtime.knowledge", () => {
  it("exposes a KnowledgeService", () => {
    const rt = createMcpRuntime(env);
    expect(rt.knowledge).toBeDefined();
    expect(typeof rt.knowledge.search).toBe("function");
    expect(typeof rt.knowledge.crawl).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project core runtime.knowledge`
Expected: FAIL — `createMcpRuntime` takes no args and/or `rt.knowledge` undefined.

- [ ] **Step 3: Implement**

In `packages/core/src/runtime.ts`:
- Add import: `import { KnowledgeService } from "./services/knowledge/index.js";`
- Add `knowledge: KnowledgeService;` to the `McpRuntime` interface.
- Change the signature to accept an env override (keeps existing callers working since it defaults to `process.env`):

```ts
export const createMcpRuntime = (env: Record<string, string | undefined> = process.env): McpRuntime => {
  const config = loadConfig(env);
  // ...existing client/service construction unchanged...
  const knowledge = new KnowledgeService(config.knowledge);

  return {
    config,
    serviceNowClient,
    azureDevOpsClient,
    incidentService,
    reportService,
    slaRiskService,
    staleTicketService,
    correlationService,
    knowledge
  };
};
```

In `packages/core/src/index.ts`, add:

```ts
export * from "./clients/llm.js";
export * from "./services/knowledge/index.js";
export * from "./services/knowledge/types.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project core runtime.knowledge`
Expected: PASS (1 test).

- [ ] **Step 5: Build core to confirm types compile**

Run: `npm run build --workspace @sre/core`
Expected: tsc succeeds, no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/runtime.ts packages/core/src/index.ts packages/core/tests/runtime.knowledge.test.ts
git commit -m "feat(core): expose knowledge on McpRuntime + exports"
```

---

## Task 14: Agent tools — `search_knowledge` + `index_url`

**Files:**
- Modify: `packages/sre-agent/src/tools/index.ts`
- Test: `packages/sre-agent/tests/knowledge-tools.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/sre-agent/tests/knowledge-tools.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { buildTools } from "../src/tools/index.js";

const fakeRuntime = () =>
  ({
    knowledge: {
      search: vi.fn(async () => ({ count: 1, results: [{ url: "https://h/a", title: "A", snippet: "x", score: 0.9 }] })),
      crawl: vi.fn(async () => ({ pagesCrawled: 2, pagesIndexed: 1, pagesSkipped: 1, dropped: 0 })),
      stats: () => ({ pages: 0, chunks: 0 })
    }
  }) as any;

const find = (rt: any, name: string) => buildTools(rt).find((t: any) => t.name === name);

describe("knowledge tools", () => {
  it("registers search_knowledge and index_url", () => {
    const rt = fakeRuntime();
    expect(find(rt, "search_knowledge")).toBeTruthy();
    expect(find(rt, "index_url")).toBeTruthy();
  });

  it("search_knowledge returns store results", async () => {
    const rt = fakeRuntime();
    const out = await find(rt, "search_knowledge").handler({ query: "restart" });
    expect(out.count).toBe(1);
    expect(rt.knowledge.search).toHaveBeenCalledWith("restart", undefined, undefined);
  });

  it("index_url clamps depth/max_pages and calls crawl", async () => {
    const rt = fakeRuntime();
    await find(rt, "index_url").handler({ url: "https://h/a", depth: 99, max_pages: 999 });
    expect(rt.knowledge.crawl).toHaveBeenCalledWith(
      { seeds: ["https://h/a"], maxDepth: 2, maxPages: 25 },
      expect.any(Function)
    );
  });

  it("returns {error} when the service throws", async () => {
    const rt = fakeRuntime();
    rt.knowledge.search.mockRejectedValueOnce(new Error("boom"));
    const out = await find(rt, "search_knowledge").handler({ query: "x" });
    expect(out.error).toContain("boom");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project sre-agent knowledge-tools`
Expected: FAIL — tools not registered.

- [ ] **Step 3: Implement**

In `packages/sre-agent/src/tools/index.ts`, append two tools to the array returned by `buildTools` (before the closing `]`), keeping the existing `defineTool`/`z`/`try-catch`+`{error}` style:

```ts
  defineTool("search_knowledge", {
    description:
      "Search the internal documentation knowledge index (runbooks, wikis, KB) by meaning. Use to find a procedure, fix, or reference relevant to an incident. Returns ranked snippets with source URLs to cite.",
    skipPermission: true,
    parameters: z.object({
      query: z.string().describe("Natural-language search query"),
      k: z.number().optional().describe("Number of results (default 6, max 20)"),
      domain: z.string().optional().describe("Restrict to a single host, e.g. wiki.acme.io")
    }),
    handler: async (a) => {
      try {
        return await runtime.knowledge.search(a.query, a.k, a.domain);
      } catch (err) {
        return { error: String(err) };
      }
    }
  }),

  defineTool("index_url", {
    description:
      "Crawl and index a small set of internal pages starting from a URL into the knowledge index, then they become searchable via search_knowledge. Bounded (shallow, few pages) for use mid-conversation; use the `sre-agent crawl` CLI for full site ingest.",
    skipPermission: true,
    parameters: z.object({
      url: z.string().describe("Seed URL to crawl from (must be within an allowed domain)"),
      depth: z.number().optional().describe("Link-follow depth, clamped to 2"),
      max_pages: z.number().optional().describe("Max pages, clamped to 25")
    }),
    handler: async (a) => {
      try {
        const res = await runtime.knowledge.crawl(
          { seeds: [a.url], maxDepth: Math.min(a.depth ?? 1, 2), maxPages: Math.min(a.max_pages ?? 10, 25) },
          () => {}
        );
        return { pages_crawled: res.pagesCrawled, chunks_added: res.pagesIndexed, skipped: res.pagesSkipped };
      } catch (err) {
        return { error: String(err) };
      }
    }
  })
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project sre-agent knowledge-tools`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/sre-agent/src/tools/index.ts packages/sre-agent/tests/knowledge-tools.test.ts
git commit -m "feat(agent): search_knowledge + index_url tools"
```

---

## Task 15: mcp-server tool parity

The existing mcp tools use `registerXTools(server: McpServer, runtime: McpRuntime)`
calling `server.tool(name, description, zodShape, handler)`, where the handler
returns `{ content: [{ type: "text", text }], isError? }` (see
`packages/mcp-server/src/tools/ado.ts`). The registrars are exported from the
`tools/index.ts` barrel and invoked in `server.ts`.

**Files:**
- Create: `packages/mcp-server/src/tools/knowledge.ts`
- Modify: `packages/mcp-server/src/tools/index.ts`
- Modify: `packages/mcp-server/src/server.ts`
- Test: `packages/mcp-server/tests/knowledge-tools.test.ts` (create `tests/` if absent)

- [ ] **Step 1: Write the failing test**

Create `packages/mcp-server/tests/knowledge-tools.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { registerKnowledgeTools } from "../src/tools/knowledge.js";

/** Fake McpServer that captures `server.tool(name, desc, shape, handler)`. */
const fakeServer = () => {
  const handlers: Record<string, (args: any) => Promise<any>> = {};
  const server = {
    tool: (name: string, _d: string, _s: unknown, handler: (a: any) => Promise<any>) => {
      handlers[name] = handler;
    }
  } as any;
  return { server, handlers };
};

const rt = () =>
  ({
    knowledge: {
      search: vi.fn(async () => ({ count: 0, results: [] })),
      crawl: vi.fn(async () => ({ pagesCrawled: 1, pagesIndexed: 1, pagesSkipped: 0, dropped: 0 }))
    }
  }) as any;

describe("mcp knowledge tools", () => {
  it("registers search_knowledge + index_url", () => {
    const { server, handlers } = fakeServer();
    registerKnowledgeTools(server, rt());
    expect(Object.keys(handlers)).toEqual(expect.arrayContaining(["search_knowledge", "index_url"]));
  });

  it("search handler delegates to runtime and returns text content", async () => {
    const { server, handlers } = fakeServer();
    const runtime = rt();
    registerKnowledgeTools(server, runtime);
    const out = await handlers.search_knowledge({ query: "x" });
    expect(runtime.knowledge.search).toHaveBeenCalledWith("x", undefined, undefined);
    expect(out.content[0].type).toBe("text");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project mcp-server knowledge-tools`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement**

Create `packages/mcp-server/src/tools/knowledge.ts`:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { McpRuntime } from "@sre/core";

const asText = (obj: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }]
});
const asError = (err: unknown) => ({
  content: [{ type: "text" as const, text: `Error: ${String(err)}` }],
  isError: true
});

export const registerKnowledgeTools = (server: McpServer, runtime: McpRuntime): void => {
  server.tool(
    "search_knowledge",
    "Search the internal documentation knowledge index by meaning; returns ranked snippets with source URLs.",
    {
      query: z.string().describe("Natural-language search query"),
      k: z.number().optional().describe("Number of results (default 6, max 20)"),
      domain: z.string().optional().describe("Restrict to a single host, e.g. wiki.acme.io")
    },
    async (args) => {
      try {
        return asText(await runtime.knowledge.search(args.query, args.k, args.domain));
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.tool(
    "index_url",
    "Crawl and index a bounded set of internal pages from a seed URL into the knowledge index.",
    {
      url: z.string().describe("Seed URL (within an allowed domain)"),
      depth: z.number().optional().describe("Link-follow depth, clamped to 2"),
      max_pages: z.number().optional().describe("Max pages, clamped to 25")
    },
    async (args) => {
      try {
        const res = await runtime.knowledge.crawl(
          { seeds: [args.url], maxDepth: Math.min(args.depth ?? 1, 2), maxPages: Math.min(args.max_pages ?? 10, 25) },
          () => {}
        );
        return asText({ pages_crawled: res.pagesCrawled, chunks_added: res.pagesIndexed, skipped: res.pagesSkipped });
      } catch (error) {
        return asError(error);
      }
    }
  );
};
```

In `packages/mcp-server/src/tools/index.ts`, add the barrel export:

```ts
export { registerKnowledgeTools } from "./knowledge.js";
```

In `packages/mcp-server/src/server.ts`, add the import next to the other tool imports (after line 7):

```ts
import { registerKnowledgeTools } from "./tools/knowledge.js";
```

and register it after `registerAdoTools(server, runtime);` (line 26):

```ts
  registerKnowledgeTools(server, runtime);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project mcp-server knowledge-tools`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server/src/tools/knowledge.ts packages/mcp-server/src/tools/index.ts packages/mcp-server/src/server.ts packages/mcp-server/tests/knowledge-tools.test.ts
git commit -m "feat(mcp): knowledge tool parity"
```

---

## Task 16: CLI `crawl` subcommand + doctor checks

**Files:**
- Modify: `packages/sre-agent/src/cli/index.ts`
- Modify: `packages/sre-agent/src/doctor.ts`
- Test: `packages/sre-agent/tests/crawl-cli.test.ts`

Known shapes (verified): the CLI dispatches via `switch (process.argv[2]) { case "init"… case "doctor"… }` inside `const run = async () => {…}` in `cli/index.ts`; it already imports `createMcpRuntime` from `@sre/core` and `loadDotenv` from `../config/env.js`, and has a `USAGE` constant. `doctor.ts` builds a `CheckResult[]` in `runChecks()` and renders via `summarizeDoctor`; `CheckResult = { name, ok, detail?, fix? }`.

- [ ] **Step 1: Write the failing test for the crawl runner**

Create `packages/sre-agent/tests/crawl-cli.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { runCrawl } from "../src/cli/crawl.js";

describe("runCrawl", () => {
  it("calls knowledge.crawl with seed overrides and prints a summary", async () => {
    const log = vi.fn();
    const rt = {
      knowledge: {
        crawl: vi.fn(async (_o: any, l: (m: string) => void) => { l("progress"); return { pagesCrawled: 3, pagesIndexed: 2, pagesSkipped: 1, dropped: 0 }; }),
        stats: () => ({ pages: 2, chunks: 5, model: "nomic-embed-text", dim: 768 }),
        close: vi.fn()
      }
    } as any;
    const code = await runCrawl(rt, ["--seed", "https://h/a"], log);
    expect(code).toBe(0);
    expect(rt.knowledge.crawl).toHaveBeenCalledWith({ seeds: ["https://h/a"] }, expect.any(Function));
  });

  it("--status prints stats without crawling", async () => {
    const rt = { knowledge: { crawl: vi.fn(), stats: () => ({ pages: 1, chunks: 2 }), close: vi.fn() } } as any;
    const code = await runCrawl(rt, ["--status"], vi.fn());
    expect(code).toBe(0);
    expect(rt.knowledge.crawl).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project sre-agent crawl-cli`
Expected: FAIL — cannot find `../src/cli/crawl.js`.

- [ ] **Step 3: Implement the crawl runner**

Create `packages/sre-agent/src/cli/crawl.ts`:

```ts
import type { McpRuntime } from "@sre/core";

/** Parse `--seed <url>` (repeatable) and `--status` from argv slice. */
const parseArgs = (argv: string[]) => {
  const seeds: string[] = [];
  let status = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--seed" && argv[i + 1]) seeds.push(argv[++i]);
    else if (argv[i] === "--status") status = true;
  }
  return { seeds, status };
};

/**
 * `sre-agent crawl [--seed <url>]... [--status]`
 * Returns a process exit code. Network/LLM work is delegated to the runtime's
 * KnowledgeService so this stays unit-testable with a fake runtime.
 */
export const runCrawl = async (
  runtime: McpRuntime,
  argv: string[],
  log: (m: string) => void = (m) => process.stderr.write(m + "\n")
): Promise<number> => {
  const { seeds, status } = parseArgs(argv);
  try {
    if (status) {
      log(`[crawl] index stats: ${JSON.stringify(runtime.knowledge.stats())}`);
      return 0;
    }
    const overrides = seeds.length > 0 ? { seeds } : {};
    const res = await runtime.knowledge.crawl(overrides, log);
    log(`[crawl] complete: ${JSON.stringify(res)}`);
    log(`[crawl] index stats: ${JSON.stringify(runtime.knowledge.stats())}`);
    return 0;
  } catch (err) {
    log(`[crawl] failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    runtime.knowledge.close?.();
  }
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project sre-agent crawl-cli`
Expected: PASS (2 tests).

- [ ] **Step 5: Wire the subcommand into the CLI entrypoint**

In `packages/sre-agent/src/cli/index.ts`, add the import next to the others (`createMcpRuntime` and `loadDotenv` are already imported):

```ts
import { runCrawl } from "./crawl.js";
```

Add a `case "crawl"` to the `switch (process.argv[2])` block in `run`, after the `doctor` case:

```ts
    case "crawl": {
      const envPath = loadDotenv();
      if (envPath) process.stderr.write(`[sre-agent] loaded config from ${envPath}\n`);
      const runtime = createMcpRuntime();
      const code = await runCrawl(runtime, process.argv.slice(3));
      process.exit(code);
    }
```

Add a line to the `USAGE` constant near the `init`/`doctor` lines:

```
  sre-agent crawl      Crawl internal docs into the knowledge index ([--seed <url>] [--status])
```

- [ ] **Step 6: Add a doctor check**

In `packages/sre-agent/src/doctor.ts`, add `createMcpRuntime` to the existing `@sre/core` import, define a check function near the other `check*` helpers:

```ts
const checkKnowledge = (): CheckResult => {
  try {
    const rt = createMcpRuntime();
    const s = rt.knowledge.stats();
    rt.knowledge.close?.();
    return { name: "Knowledge index", ok: true, detail: `pages=${s.pages}, chunks=${s.chunks}, model=${s.model ?? "?"}` };
  } catch (e) {
    return {
      name: "Knowledge index",
      ok: false,
      detail: "sqlite-vec / store unavailable",
      fix: e instanceof Error ? e.message : String(e)
    };
  }
};
```

and push it inside the `if (config) { … }` block in `runChecks` (only when config is valid, since `createMcpRuntime` loads + validates env):

```ts
    results.push(checkKnowledge());
```

Note: this verifies the store opens and sqlite-vec loads; embed-endpoint reachability is only exercised on an actual crawl/search (it needs Ollama up, which `doctor` should not require).

- [ ] **Step 7: Build the agent to confirm it compiles**

Run: `npm run build --workspace @sre/sre-agent`
Expected: tsc succeeds.

- [ ] **Step 8: Commit**

```bash
git add packages/sre-agent/src/cli/index.ts packages/sre-agent/src/cli/crawl.ts packages/sre-agent/src/doctor.ts packages/sre-agent/tests/crawl-cli.test.ts
git commit -m "feat(agent): crawl CLI subcommand + doctor knowledge check"
```

---

## Task 17: Documentation

**Files:**
- Modify: `packages/sre-agent/.env.example`
- Modify: `packages/sre-agent/README.md`

- [ ] **Step 1: Add the crawl env block to `.env.example`**

Append to `packages/sre-agent/.env.example`:

```bash
# ── Knowledge crawler (internal docs → semantic index) ───────────────────────
# Crawl needs a local Ollama (or any OpenAI-compatible) endpoint for the
# crawl-brain chat model + an embedding model. Reuses LLM_BASE_URL if EMBED_BASE_URL unset.
KNOWLEDGE_DB_PATH=                                   # default ~/.sre-agent/knowledge.db
CRAWL_SEEDS=                                         # comma list of seed URLs; required for `crawl`
CRAWL_ALLOW_DOMAINS=                                 # comma list of hosts; default = hosts of seeds
CRAWL_MAX_PAGES=200                                  # hard page cap per crawl
CRAWL_MAX_DEPTH=3                                    # link-follow depth
CRAWL_CONCURRENCY=4                                  # reserved (crawl is sequential in v1)
CRAWL_RATE_MS=500                                    # polite delay between requests
CRAWL_MAX_BYTES=2097152                              # 2MB per-page body guard
CRAWL_PROXY=                                         # optional http(s) proxy for crawl + embed traffic
CRAWL_RESPECT_ROBOTS=true                            # honor robots.txt
CRAWL_TOPIC=                                         # optional relevance anchor for the LLM gate
EMBED_MODEL=nomic-embed-text                         # embedding model (dim pinned in the index)
EMBED_BASE_URL=                                      # default = LLM_BASE_URL, else http://localhost:11434/v1
CRAWL_LLM_MODEL=qwen2.5                              # crawl-brain chat model (must support following instructions)
```

- [ ] **Step 2: Add a README section**

Add to `packages/sre-agent/README.md` (after the LLM section):

```markdown
### Knowledge crawler

Build a semantic index of internal docs the agent can search.

1. Run a local Ollama with a chat model and an embedding model:
   `ollama pull qwen2.5 && ollama pull nomic-embed-text`
2. Set `CRAWL_SEEDS` (and optionally `CRAWL_ALLOW_DOMAINS`, `CRAWL_TOPIC`) in `.env`.
3. Full ingest: `sre-agent crawl` (or `sre-agent crawl --seed https://wiki/x`).
   Check the index: `sre-agent crawl --status`.
4. In chat the agent uses `search_knowledge` to retrieve, and `index_url` for a
   small on-demand top-up crawl.

The crawler is LLM-guided (a local model decides which pages/links are relevant)
and stores embeddings in a single SQLite + sqlite-vec file (`KNOWLEDGE_DB_PATH`).
It fetches over the existing proxy and assumes network-trusted internal sites (no
credentials). Changing `EMBED_MODEL` after a crawl requires deleting the index
(embedding dim is pinned).
```

- [ ] **Step 3: Commit**

```bash
git add packages/sre-agent/.env.example packages/sre-agent/README.md
git commit -m "docs(agent): document the knowledge crawler"
```

---

## Task 18: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Build everything**

Run: `npm run build`
Expected: all three workspaces compile, no tsc errors.

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: all suites pass (existing + new). If a new test fails, fix the implementation (not the test) unless the test encodes a wrong expectation.

- [ ] **Step 3: Smoke-test the CLI wiring (no network needed for failure path)**

Run: `node packages/sre-agent/dist/cli/index.js crawl --status`
Expected: prints index stats JSON (empty index: `pages=0, chunks=0`) OR a clear sqlite-vec/embeddings error — not a stack trace crash.

- [ ] **Step 4: Optional live smoke (needs Ollama + a reachable internal/test site)**

Run: `CRAWL_SEEDS=https://example.com EMBED_MODEL=nomic-embed-text node packages/sre-agent/dist/cli/index.js crawl`
Expected: crawls a few pages, prints a result summary; `crawl --status` then shows pages/chunks > 0.

- [ ] **Step 5: Final commit (if any verification fixups were made)**

```bash
git add -A
git commit -m "test: fixups from full crawler verification"
```

---

## Notes for the implementer

- **`createMcpRuntime` signature change** (Task 13) adds an optional `env` arg with a default — existing zero-arg callers (mcp-server, sre-agent) keep working. Verify those call sites still compile in Task 18 Step 1.
- **mcp-server registration (Task 15)** uses `registerKnowledgeTools(server, runtime)` + `server.tool(...)` and is wired in `server.ts` after `registerAdoTools`; **CLI/doctor wiring (Task 16)** adds a `case "crawl"` to the `switch (process.argv[2])` in `cli/index.ts` and a `CheckResult` in `runChecks`. Both match the verified existing shapes — don't invent a new mechanism.
- **`better-sqlite3` is native.** If `npm install` can't find a prebuilt for the platform, it compiles (needs a C++ toolchain). The Task 1 Step 3 check catches this early.
- **Embedding dim** is hardcoded per model in `EMBED_DIMS` (Task 12). `nomic-embed-text` = 768. If a different model is configured without an entry, `getStore()` throws a clear error.
- **Concurrency** is declared in config but the v1 crawl loop is sequential (politeness + simpler dedup). Parallelizing within `allowDomains`/`rateMs` is a future enhancement, not a v1 task.
