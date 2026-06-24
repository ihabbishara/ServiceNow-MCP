# LLM-Agnostic Crawler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the internal crawler so it works in both agent LLM modes (seat + BYOK) with zero Ollama dependency — local in-process embeddings, and a verdict chat model that is BYOK-provider HTTP or absent (→ heuristic crawl) in seat mode.

**Architecture:** Replace the single Ollama-backed `LlmClient {chat, embed}` with two independent capabilities: a `LocalEmbedder` (in-process ONNX via transformers.js, offline-capable) and an optional `ChatModel` (BYOK provider HTTP: openai/azure/anthropic; `undefined` in seat mode → heuristic verdict). The crawl orchestrator takes `embedder` (required) + `chat?` (optional) and feeds an identity verdict through the same pipeline when chat is absent.

**Tech Stack:** TypeScript (ESM, NodeNext), `undici`, `better-sqlite3`+`sqlite-vec`, `@huggingface/transformers` (new), `zod`, `vitest`. Refactors code merged on `main`.

**Conventions (from the codebase):**
- ESM imports use explicit `.js` extensions even for `.ts` sources; all imports at top of file.
- HTTP via `import { fetch } from "undici"` + `dispatcher: proxyDispatcher(proxyUrl)`.
- Tests mock undici with `vi.mock("undici", async (orig) => ({ ...(await orig()), fetch: vi.fn() }))` — NOT `vi.spyOn(undici,"fetch")` (fails in ESM, `configurable:false`). See `packages/core/tests/fetcher.test.ts`.
- Tool/handler error shape `{ error: String(err) }`, never throw.
- Run tests/build/git from repo root `/Users/ihabbishara/projects/ServiceNowMCP`. No `cd` in compound commands.
- Run one project: `npx vitest run --project core <namefilter>`. Full suite: `npm test`. Build: `npm run build`.

---

## File Structure

**Create:**
- `packages/core/src/clients/embedder.ts` — `LocalEmbedder` (in-process ONNX embeddings).
- `packages/core/src/clients/chat/types.ts` — `ChatModel` interface.
- `packages/core/src/clients/chat/openai.ts` — `OpenAiChat` (OpenAI-compatible + Azure).
- `packages/core/src/clients/chat/anthropic.ts` — `AnthropicChat` (Messages API).
- `packages/core/src/clients/chat/factory.ts` — `makeChatModel(cfg?, proxyUrl)` + `ChatConfig`.
- Tests for each of the above.

**Modify:**
- `packages/core/src/services/knowledge/types.ts` — add `Embedder`, remove `LlmClient`.
- `packages/core/src/services/knowledge/crawl.ts` — `CrawlDeps.embedder` + `CrawlDeps.chat?`; heuristic verdict.
- `packages/core/src/services/knowledge/search.ts` — `embedder` instead of `llm`.
- `packages/core/src/services/knowledge/index.ts` (facade) — build embedder+chat; async `ensureStore`/`stats`; remove `EMBED_DIMS`.
- `packages/core/src/config.ts` — `KnowledgeConfig` (embedder + chat) from `LLM_*` env.
- `packages/core/src/index.ts` — export the new chat/embedder modules; drop `llm.js` export.
- `packages/core/package.json` — add `@huggingface/transformers`.
- `packages/sre-agent/src/cli/crawl.ts` + `packages/sre-agent/src/doctor.ts` — `await` the now-async `stats()`.
- `packages/sre-agent/.env.example` + `packages/sre-agent/README.md` — replace the Ollama crawl block.

**Delete:**
- `packages/core/src/clients/llm.ts` and `packages/core/tests/llm.test.ts` (Ollama retired).

---

## Task 1: Add `@huggingface/transformers` to `@sre/core`

**Files:** Modify `packages/core/package.json`

- [ ] **Step 1: Add the dependency**

In `packages/core/package.json`, add to `dependencies` (keep keys sorted, keep all existing entries):

```json
"@huggingface/transformers": "^3.3.0"
```

So `dependencies` becomes:
```json
"dependencies": {
  "@huggingface/transformers": "^3.3.0",
  "@mozilla/readability": "^0.5.0",
  "better-sqlite3": "^11.8.0",
  "linkedom": "^0.18.5",
  "sqlite-vec": "^0.1.6",
  "undici": "^6.27.0",
  "zod": "^3.24.0"
}
```

- [ ] **Step 2: Install**

Run: `npm install`
Expected: installs without error (transformers.js ships wasm runtime; no native compile required).

- [ ] **Step 3: Commit**

```bash
git add packages/core/package.json package-lock.json
git commit -m "build(core): add @huggingface/transformers for local embeddings"
```

---

## Task 2: Capability interfaces — `Embedder` + `ChatModel`

**Files:**
- Modify: `packages/core/src/services/knowledge/types.ts`
- Create: `packages/core/src/clients/chat/types.ts`

- [ ] **Step 1: Add `Embedder`, remove `LlmClient` in knowledge types**

In `packages/core/src/services/knowledge/types.ts`, DELETE the `LlmClient` interface:

```ts
/** Minimal LLM surface the crawl/search code depends on. */
export interface LlmClient {
  chat(prompt: string): Promise<string>;
  embed(text: string): Promise<number[]>;
}
```

and ADD in its place:

```ts
/** Produces embedding vectors. The crawler's only vector source (local, in-process). */
export interface Embedder {
  readonly model: string;
  /** Embedding dimension; valid only after `ready()` (or first `embed`). */
  readonly dim: number;
  /** Loads the model so `dim` is known; idempotent. */
  ready(): Promise<void>;
  embed(text: string): Promise<number[]>;
}
```

- [ ] **Step 2: Create the `ChatModel` interface**

Create `packages/core/src/clients/chat/types.ts`:

```ts
/** A one-shot chat completion used for the crawl relevance/link verdict. */
export interface ChatModel {
  chat(prompt: string): Promise<string>;
}
```

- [ ] **Step 3: Verify compile expectation**

Run: `npx tsc -b packages/core 2>&1 | head -20`
Expected: FAILS — `llm.ts`, `crawl.ts`, `search.ts` still import the removed `LlmClient`. That's expected; later tasks fix them. (Do not try to fix here.)

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/services/knowledge/types.ts packages/core/src/clients/chat/types.ts
git commit -m "refactor(core): split LlmClient into Embedder + ChatModel interfaces"
```

---

## Task 3: `LocalEmbedder`

**Files:**
- Create: `packages/core/src/clients/embedder.ts`
- Test: `packages/core/tests/embedder.test.ts`

- [ ] **Step 1: Write the failing test (mock the transformers pipeline — no model download)**

Create `packages/core/tests/embedder.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the heavy ML lib so tests never load a real model.
const pipe = vi.fn(async (_text: string, _opts: unknown) => ({ data: new Float32Array([0.1, 0.2, 0.3]) }));
const pipeline = vi.fn(async () => pipe);
const env: any = {};
vi.mock("@huggingface/transformers", () => ({ pipeline, env }));

import { LocalEmbedder } from "../src/clients/embedder.js";

beforeEach(() => {
  pipe.mockClear();
  pipeline.mockClear();
  delete env.allowRemoteModels;
  delete env.localModelPath;
});

describe("LocalEmbedder", () => {
  it("loads the pipeline once and captures dim", async () => {
    const e = new LocalEmbedder("Xenova/bge-small-en-v1.5");
    await e.ready();
    await e.ready(); // idempotent
    expect(pipeline).toHaveBeenCalledTimes(1);
    expect(e.dim).toBe(3);
    expect(e.model).toBe("Xenova/bge-small-en-v1.5");
  });

  it("embed returns a plain number[] (mean+normalize opts passed)", async () => {
    const e = new LocalEmbedder("m");
    const v = await e.embed("hello");
    expect(v).toEqual([
      expect.closeTo(0.1), expect.closeTo(0.2), expect.closeTo(0.3)
    ]);
    expect(Array.isArray(v)).toBe(true);
    expect(pipe).toHaveBeenCalledWith("hello", { pooling: "mean", normalize: true });
  });

  it("offline mode: modelPath sets env.localModelPath + disables remote", () => {
    new LocalEmbedder("m", "/opt/models/bge");
    expect(env.allowRemoteModels).toBe(false);
    expect(env.localModelPath).toBe("/opt/models/bge");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project core embedder`
Expected: FAIL — cannot find `../src/clients/embedder.js`.

- [ ] **Step 3: Implement**

Create `packages/core/src/clients/embedder.ts`:

```ts
import { pipeline, env } from "@huggingface/transformers";
import type { Embedder } from "../services/knowledge/types.js";

/**
 * In-process embeddings via transformers.js (ONNX, CPU). No external service —
 * this is what makes the crawler work regardless of the agent's LLM mode and
 * with zero Ollama dependency. When `modelPath` is set the model loads from a
 * local directory with remote downloads disabled (offline / locked-down nets).
 */
export class LocalEmbedder implements Embedder {
  readonly model: string;
  dim = 0;
  private pipe?: (text: string, opts: unknown) => Promise<{ data: Float32Array }>;

  constructor(model: string, modelPath?: string) {
    this.model = model;
    if (modelPath) {
      env.allowRemoteModels = false;
      env.localModelPath = modelPath;
    }
  }

  async ready(): Promise<void> {
    if (this.pipe) return;
    this.pipe = (await pipeline("feature-extraction", this.model)) as typeof this.pipe;
    const probe = await this.pipe!("x", { pooling: "mean", normalize: true });
    this.dim = probe.data.length;
  }

  async embed(text: string): Promise<number[]> {
    if (!this.pipe) await this.ready();
    const out = await this.pipe!(text, { pooling: "mean", normalize: true });
    return Array.from(out.data);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project core embedder`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/clients/embedder.ts packages/core/tests/embedder.test.ts
git commit -m "feat(core): LocalEmbedder (in-process ONNX embeddings)"
```

---

## Task 4: `OpenAiChat` (OpenAI-compatible + Azure)

**Files:**
- Create: `packages/core/src/clients/chat/openai.ts`
- Test: `packages/core/tests/chat-openai.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/tests/chat-openai.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import * as undici from "undici";
import { OpenAiChat } from "../src/clients/chat/openai.js";

vi.mock("undici", async (orig) => ({ ...(await orig<typeof import("undici")>()), fetch: vi.fn() }));
const fetchMock = undici.fetch as unknown as ReturnType<typeof vi.fn>;
afterEach(() => fetchMock.mockReset());

const ok = (content: string) => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) });

describe("OpenAiChat", () => {
  it("openai: posts to /chat/completions with Bearer auth", async () => {
    fetchMock.mockResolvedValue(ok("hi") as any);
    const c = new OpenAiChat({ type: "openai", baseUrl: "https://api.x/v1", model: "gpt-4o", apiKey: "k" });
    expect(await c.chat("p")).toBe("hi");
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.x/v1/chat/completions");
    expect((opts as any).headers.authorization).toBe("Bearer k");
    expect(JSON.parse((opts as any).body).model).toBe("gpt-4o");
  });

  it("azure: deployment URL + api-version + api-key header", async () => {
    fetchMock.mockResolvedValue(ok("yo") as any);
    const c = new OpenAiChat({ type: "azure", baseUrl: "https://r.openai.azure.com", model: "dep1", apiKey: "k", apiVersion: "2024-10-21" });
    await c.chat("p");
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://r.openai.azure.com/openai/deployments/dep1/chat/completions?api-version=2024-10-21");
    expect((opts as any).headers["api-key"]).toBe("k");
  });

  it("throws on non-ok", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => "boom" } as any);
    const c = new OpenAiChat({ type: "openai", baseUrl: "https://api.x/v1", model: "m" });
    await expect(c.chat("p")).rejects.toThrow(/500/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project core chat-openai`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/core/src/clients/chat/openai.ts`:

```ts
import { fetch } from "undici";
import { proxyDispatcher, FetchDispatcher } from "../proxy.js";
import type { ChatModel } from "./types.js";

export interface OpenAiChatOptions {
  type: "openai" | "azure";
  baseUrl: string;
  model: string;
  apiKey?: string;
  apiVersion?: string; // azure only
  proxyUrl?: string;
}

/** OpenAI-compatible chat (also serves Azure OpenAI and self-hosted OpenAI-compatible endpoints). */
export class OpenAiChat implements ChatModel {
  private readonly dispatcher?: FetchDispatcher;
  constructor(private readonly opts: OpenAiChatOptions) {
    this.dispatcher = proxyDispatcher(opts.proxyUrl);
  }

  private url(): string {
    if (this.opts.type === "azure") {
      const v = this.opts.apiVersion ?? "2024-10-21";
      return `${this.opts.baseUrl}/openai/deployments/${this.opts.model}/chat/completions?api-version=${v}`;
    }
    return `${this.opts.baseUrl}/chat/completions`;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.opts.apiKey) {
      if (this.opts.type === "azure") h["api-key"] = this.opts.apiKey;
      else h.authorization = `Bearer ${this.opts.apiKey}`;
    }
    return h;
  }

  async chat(prompt: string): Promise<string> {
    const res = await fetch(this.url(), {
      method: "POST",
      headers: this.headers(),
      dispatcher: this.dispatcher,
      body: JSON.stringify({
        model: this.opts.model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
        stream: false
      })
    });
    if (!res.ok) throw new Error(`chat failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? "";
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project core chat-openai`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/clients/chat/openai.ts packages/core/tests/chat-openai.test.ts
git commit -m "feat(core): OpenAI-compatible + Azure chat client"
```

---

## Task 5: `AnthropicChat`

**Files:**
- Create: `packages/core/src/clients/chat/anthropic.ts`
- Test: `packages/core/tests/chat-anthropic.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/tests/chat-anthropic.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest";
import * as undici from "undici";
import { AnthropicChat } from "../src/clients/chat/anthropic.js";

vi.mock("undici", async (orig) => ({ ...(await orig<typeof import("undici")>()), fetch: vi.fn() }));
const fetchMock = undici.fetch as unknown as ReturnType<typeof vi.fn>;
afterEach(() => fetchMock.mockReset());

describe("AnthropicChat", () => {
  it("posts to /v1/messages with x-api-key + anthropic-version and parses content[0].text", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ content: [{ text: "hey" }] }) } as any);
    const c = new AnthropicChat({ baseUrl: "https://api.anthropic.com", model: "claude-x", apiKey: "k" });
    expect(await c.chat("p")).toBe("hey");
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect((opts as any).headers["x-api-key"]).toBe("k");
    expect((opts as any).headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse((opts as any).body);
    expect(body.model).toBe("claude-x");
    expect(body.max_tokens).toBeGreaterThan(0);
  });

  it("throws on non-ok", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => "no" } as any);
    const c = new AnthropicChat({ baseUrl: "https://api.anthropic.com", model: "m" });
    await expect(c.chat("p")).rejects.toThrow(/401/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project core chat-anthropic`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/core/src/clients/chat/anthropic.ts`:

```ts
import { fetch } from "undici";
import { proxyDispatcher, FetchDispatcher } from "../proxy.js";
import type { ChatModel } from "./types.js";

export interface AnthropicChatOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  maxTokens?: number;
  proxyUrl?: string;
}

/** Anthropic Messages API chat client. */
export class AnthropicChat implements ChatModel {
  private readonly dispatcher?: FetchDispatcher;
  constructor(private readonly opts: AnthropicChatOptions) {
    this.dispatcher = proxyDispatcher(opts.proxyUrl);
  }

  async chat(prompt: string): Promise<string> {
    const res = await fetch(`${this.opts.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.opts.apiKey ?? "",
        "anthropic-version": "2023-06-01"
      },
      dispatcher: this.dispatcher,
      body: JSON.stringify({
        model: this.opts.model,
        max_tokens: this.opts.maxTokens ?? 1024,
        messages: [{ role: "user", content: prompt }]
      })
    });
    if (!res.ok) throw new Error(`chat failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { content?: { text?: string }[] };
    return data.content?.[0]?.text ?? "";
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project core chat-anthropic`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/clients/chat/anthropic.ts packages/core/tests/chat-anthropic.test.ts
git commit -m "feat(core): Anthropic Messages chat client"
```

---

## Task 6: `makeChatModel` factory

**Files:**
- Create: `packages/core/src/clients/chat/factory.ts`
- Test: `packages/core/tests/chat-factory.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/core/tests/chat-factory.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { makeChatModel } from "../src/clients/chat/factory.js";
import { OpenAiChat } from "../src/clients/chat/openai.js";
import { AnthropicChat } from "../src/clients/chat/anthropic.js";

describe("makeChatModel", () => {
  it("returns undefined when no config (seat mode)", () => {
    expect(makeChatModel(undefined)).toBeUndefined();
  });
  it("openai/azure -> OpenAiChat", () => {
    expect(makeChatModel({ type: "openai", baseUrl: "u", model: "m" })).toBeInstanceOf(OpenAiChat);
    expect(makeChatModel({ type: "azure", baseUrl: "u", model: "m", apiVersion: "v" })).toBeInstanceOf(OpenAiChat);
  });
  it("anthropic -> AnthropicChat", () => {
    expect(makeChatModel({ type: "anthropic", baseUrl: "u", model: "m" })).toBeInstanceOf(AnthropicChat);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project core chat-factory`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `packages/core/src/clients/chat/factory.ts`:

```ts
import type { ChatModel } from "./types.js";
import { OpenAiChat } from "./openai.js";
import { AnthropicChat } from "./anthropic.js";

/** Provider config for the crawl verdict chat; derived from the agent's LLM_* env. */
export interface ChatConfig {
  type: "openai" | "azure" | "anthropic";
  baseUrl: string;
  model: string;
  apiKey?: string;
  apiVersion?: string;
}

/** Build a ChatModel from BYOK config, or undefined (seat mode → heuristic crawl). */
export const makeChatModel = (cfg?: ChatConfig, proxyUrl?: string): ChatModel | undefined => {
  if (!cfg) return undefined;
  if (cfg.type === "anthropic") {
    return new AnthropicChat({ baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey, proxyUrl });
  }
  return new OpenAiChat({
    type: cfg.type,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    apiKey: cfg.apiKey,
    apiVersion: cfg.apiVersion,
    proxyUrl
  });
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project core chat-factory`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/clients/chat/factory.ts packages/core/tests/chat-factory.test.ts
git commit -m "feat(core): chat model factory (byok -> client, seat -> none)"
```

---

## Task 7: Config — embedder + chat from `LLM_*` env

**Files:**
- Modify: `packages/core/src/config.ts`
- Test: `packages/core/tests/config.knowledge.test.ts` (update existing)

- [ ] **Step 1: Update the test (TDD — encode the new contract)**

Replace the body of `packages/core/tests/config.knowledge.test.ts` with:

```ts
import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

const base = {
  SERVICENOW_BASE_URL: "https://x.service-now.com",
  SERVICENOW_USERNAME: "u",
  SERVICENOW_PASSWORD: "p"
};

describe("knowledge config", () => {
  it("applies defaults (local embed model, no chat in seat mode)", () => {
    const c = loadConfig(base);
    expect(c.knowledge.maxPages).toBe(200);
    expect(c.knowledge.maxDepth).toBe(3);
    expect(c.knowledge.embedModel).toBe("Xenova/bge-small-en-v1.5");
    expect(c.knowledge.embedModelPath).toBeUndefined();
    expect(c.knowledge.respectRobots).toBe(true);
    expect(c.knowledge.seeds).toEqual([]);
    expect(c.knowledge.chat).toBeUndefined(); // seat default → heuristic crawl
  });

  it("parses seeds + derives allowDomains from seed hosts", () => {
    const c = loadConfig({ ...base, CRAWL_SEEDS: "https://wiki.acme.io/a, https://kb.acme.io/b" });
    expect(c.knowledge.seeds).toEqual(["https://wiki.acme.io/a", "https://kb.acme.io/b"]);
    expect(c.knowledge.allowDomains).toEqual(["wiki.acme.io", "kb.acme.io"]);
  });

  it("byok → knowledge.chat derived from LLM_* env", () => {
    const c = loadConfig({
      ...base,
      LLM_MODE: "byok",
      LLM_PROVIDER: "azure",
      LLM_BASE_URL: "https://r.openai.azure.com",
      LLM_API_KEY: "secret",
      LLM_MODEL: "dep1",
      AZURE_API_VERSION: "2024-10-21"
    });
    expect(c.knowledge.chat).toEqual({
      type: "azure",
      baseUrl: "https://r.openai.azure.com",
      apiKey: "secret",
      model: "dep1",
      apiVersion: "2024-10-21"
    });
  });

  it("byok without provider/base-url → chat undefined (no half-config)", () => {
    const c = loadConfig({ ...base, LLM_MODE: "byok" });
    expect(c.knowledge.chat).toBeUndefined();
  });

  it("EMBED_MODEL_PATH carried through", () => {
    const c = loadConfig({ ...base, EMBED_MODEL_PATH: "/opt/models/bge" });
    expect(c.knowledge.embedModelPath).toBe("/opt/models/bge");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project core config.knowledge`
Expected: FAIL — `embedModel` is still the old default; `chat`/`embedModelPath` undefined fields don't exist.

- [ ] **Step 3: Implement config changes**

In `packages/core/src/config.ts` `envSchema`, REPLACE these three lines:

```ts
  EMBED_MODEL: z.string().default("nomic-embed-text"),
  EMBED_BASE_URL: optional(z.string().url()),
  LLM_BASE_URL: optional(z.string().url()),
  CRAWL_LLM_MODEL: z.string().default("qwen2.5")
```

with:

```ts
  EMBED_MODEL: z.string().default("Xenova/bge-small-en-v1.5"),
  EMBED_MODEL_PATH: optional(z.string().min(1)),
  // Verdict chat reuses the agent's LLM_* env (byok → provider HTTP; seat → heuristic).
  LLM_MODE: z.enum(["seat", "byok"]).default("seat"),
  LLM_PROVIDER: optional(z.enum(["azure", "anthropic", "openai"])),
  LLM_BASE_URL: optional(z.string().url()),
  LLM_API_KEY: optional(z.string().min(1)),
  LLM_MODEL: z.string().default("gpt-5"),
  AZURE_API_VERSION: z.string().default("2024-10-21")
```

In the `KnowledgeConfig` interface, REPLACE:

```ts
  embedModel: string;
  embedBaseUrl: string;
  crawlModel: string;
}
```

with:

```ts
  embedModel: string;
  embedModelPath?: string;
  chat?: {
    type: "openai" | "azure" | "anthropic";
    baseUrl: string;
    model: string;
    apiKey?: string;
    apiVersion?: string;
  };
}
```

In `loadConfig`, REPLACE the tail of the `knowledge` object:

```ts
    embedModel: e.EMBED_MODEL,
    embedBaseUrl: e.EMBED_BASE_URL || e.LLM_BASE_URL || "http://localhost:11434/v1",
    crawlModel: e.CRAWL_LLM_MODEL
  };
```

with:

```ts
    embedModel: e.EMBED_MODEL,
    embedModelPath: e.EMBED_MODEL_PATH,
    chat:
      e.LLM_MODE === "byok" && e.LLM_PROVIDER && e.LLM_BASE_URL
        ? {
            type: e.LLM_PROVIDER,
            baseUrl: e.LLM_BASE_URL,
            apiKey: e.LLM_API_KEY,
            model: e.LLM_MODEL,
            apiVersion: e.AZURE_API_VERSION
          }
        : undefined
  };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project core config.knowledge`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/config.ts packages/core/tests/config.knowledge.test.ts
git commit -m "feat(core): knowledge config — local embed model + byok chat from LLM_* env"
```

---

## Task 8: Crawl orchestrator — embedder + optional chat (heuristic when absent)

**Files:**
- Modify: `packages/core/src/services/knowledge/crawl.ts`
- Test: `packages/core/tests/crawl.test.ts` (update + add heuristic case)

- [ ] **Step 1: Update the test deps + add heuristic case**

In `packages/core/tests/crawl.test.ts`, change the `makeDeps` helper so the injected LLM is split into `embedder` + `chat` (find the object that currently has `llm: { chat, embed }` and replace that property):

```ts
    // was: llm: { chat: vi.fn(...), embed: vi.fn(...) }
    embedder: { embed: vi.fn(async () => [1, 0, 0]) },
    chat: { chat: vi.fn(async () => JSON.stringify({ relevant: true, keepLinks: ["https://h/a", "https://h/b", "https://other/x"] })) },
```

Update any test that referenced `deps.llm.chat`/`deps.llm.embed` to `deps.chat.chat`/`deps.embedder.embed`.

Add a new test (heuristic mode — `chat` omitted):

```ts
it("heuristic crawl when no chat model: indexes every in-scope page, follows all in-scope links", async () => {
  const deps = makeDeps();
  delete (deps as any).chat; // seat mode → no verdict LLM
  const res = await crawl(deps, {
    seeds: ["https://h/seed"], allowDomains: ["h"], maxPages: 10, maxDepth: 3,
    concurrency: 1, rateMs: 0, maxLinksPerPage: 50
  });
  const fetched = (deps.fetcher.get as any).mock.calls.map((c: any[]) => c[0]);
  expect(fetched).toEqual(expect.arrayContaining(["https://h/seed", "https://h/a", "https://h/b"]));
  expect(fetched).not.toContain("https://other/x"); // out of scope still excluded
  expect(res.pagesIndexed).toBe(3); // all in-scope pages indexed
  expect(res.chunksAdded).toBeGreaterThan(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project core crawl`
Expected: FAIL — `CrawlDeps` still has `llm`; `deps.embedder`/`deps.chat` not used by the implementation.

- [ ] **Step 3: Implement**

In `packages/core/src/services/knowledge/crawl.ts`:

Change the import (line 2) from:
```ts
import type { FetchResult, LlmClient, PageDoc } from "./types.js";
```
to:
```ts
import type { Embedder, FetchResult, PageDoc } from "./types.js";
import type { ChatModel } from "../../clients/chat/types.js";
```

In `CrawlDeps`, REPLACE `llm: LlmClient;` with:
```ts
  embedder: Pick<Embedder, "embed">;
  /** Optional verdict chat. Absent (seat mode) → heuristic crawl. */
  chat?: ChatModel;
```

REPLACE the verdict block:
```ts
    // Combined relevance + link-keep verdict.
    const prompt = buildVerdictPrompt(bounds.topic, doc.title, doc.mainText.slice(0, 2000), doc.links, bounds.maxLinksPerPage);
    let verdict;
    try {
      verdict = parseVerdict(await deps.llm.chat(prompt));
    } catch (e) {
      deps.log(`[crawl] verdict failed for ${url}; keeping page, no links: ${String(e)}`);
      verdict = { relevant: true, keepLinks: [] as string[] };
    }
```
with:
```ts
    // Verdict: LLM (byok) when a chat model is present; otherwise heuristic
    // (seat mode) — index the page and follow all its links (scope/depth/cap
    // gates below still bound it).
    let verdict: { relevant: boolean; keepLinks: string[] };
    if (deps.chat) {
      const prompt = buildVerdictPrompt(bounds.topic, doc.title, doc.mainText.slice(0, 2000), doc.links, bounds.maxLinksPerPage);
      try {
        verdict = parseVerdict(await deps.chat.chat(prompt));
      } catch (e) {
        deps.log(`[crawl] verdict failed for ${url}; keeping page, no links: ${String(e)}`);
        verdict = { relevant: true, keepLinks: [] };
      }
    } else {
      verdict = { relevant: true, keepLinks: doc.links };
    }
```

REPLACE the embed line:
```ts
          embedded.push({ ord: i, text: chunks[i], embedding: await deps.llm.embed(chunks[i]) });
```
with:
```ts
          embedded.push({ ord: i, text: chunks[i], embedding: await deps.embedder.embed(chunks[i]) });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project core crawl`
Expected: PASS (existing cases + the new heuristic case).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/services/knowledge/crawl.ts packages/core/tests/crawl.test.ts
git commit -m "refactor(core): crawl uses Embedder + optional ChatModel (heuristic in seat mode)"
```

---

## Task 9: Search — embedder instead of llm

**Files:**
- Modify: `packages/core/src/services/knowledge/search.ts`
- Test: `packages/core/tests/search.test.ts` (update)

- [ ] **Step 1: Update the test**

In `packages/core/tests/search.test.ts`, change the fake dep `llm` → `embedder` and the assertion. Replace the two fakes/calls so they read:

```ts
const embedder = { embed: vi.fn(async () => [1, 0, 0]) };
// ...
const res = await search({ embedder, store } as any, "how to restart", 3);
expect(embedder.embed).toHaveBeenCalledWith("how to restart");
```

(Apply the same `llm` → `embedder` rename in the empty-index test.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project core search`
Expected: FAIL — `search` still reads `deps.llm`.

- [ ] **Step 3: Implement**

In `packages/core/src/services/knowledge/search.ts`:

Change the import from:
```ts
import type { LlmClient, SearchHit } from "./types.js";
```
to:
```ts
import type { Embedder, SearchHit } from "./types.js";
```

Change the deps type + embed call. Replace:
```ts
  deps: { llm: Pick<LlmClient, "embed">; store: Pick<KnowledgeStore, "knn"> },
```
with:
```ts
  deps: { embedder: Pick<Embedder, "embed">; store: Pick<KnowledgeStore, "knn"> },
```
and replace:
```ts
  const vec = await deps.llm.embed(query);
```
with:
```ts
  const vec = await deps.embedder.embed(query);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project core search`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/services/knowledge/search.ts packages/core/tests/search.test.ts
git commit -m "refactor(core): search uses Embedder"
```

---

## Task 10: Facade — build embedder + chat, async store/stats; delete Ollama client

**Files:**
- Modify: `packages/core/src/services/knowledge/index.ts`
- Modify: `packages/core/src/index.ts`
- Delete: `packages/core/src/clients/llm.ts`, `packages/core/tests/llm.test.ts`

- [ ] **Step 1: Rewrite the facade**

Replace the entire contents of `packages/core/src/services/knowledge/index.ts` with:

```ts
import type { KnowledgeConfig } from "../../config.js";
import { LocalEmbedder } from "../../clients/embedder.js";
import { makeChatModel } from "../../clients/chat/factory.js";
import type { ChatModel } from "../../clients/chat/types.js";
import { Fetcher } from "../../clients/crawler/fetcher.js";
import { extractPage } from "../../clients/crawler/extract.js";
import { RobotsClient } from "../../clients/crawler/robotsClient.js";
import { KnowledgeStore } from "./store.js";
import { crawl, type CrawlBounds, type CrawlResult } from "./crawl.js";
import { search, type SearchResponse } from "./search.js";
import type { KnowledgeStats } from "./types.js";

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

  async search(query: string, k?: number, domain?: string): Promise<SearchResponse> {
    const store = await this.ensureStore();
    return search({ embedder: this.embedder, store }, query, k, domain);
  }

  async stats(): Promise<KnowledgeStats> {
    const store = await this.ensureStore();
    return store.stats();
  }

  close(): void {
    this.store?.close();
  }
}
```

- [ ] **Step 2: Delete the Ollama client + its test**

```bash
git rm packages/core/src/clients/llm.ts packages/core/tests/llm.test.ts
```

- [ ] **Step 3: Update the core barrel**

In `packages/core/src/index.ts`, REMOVE:
```ts
export * from "./clients/llm.js";
```
and ADD:
```ts
export * from "./clients/embedder.js";
export * from "./clients/chat/types.js";
export * from "./clients/chat/factory.js";
```

- [ ] **Step 4: Build core to confirm types resolve**

Run: `npm run build --workspace @sre/core`
Expected: tsc succeeds (no more `LlmClient`/`OllamaClient` references anywhere in core).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/services/knowledge/index.ts packages/core/src/index.ts
git commit -m "refactor(core): facade builds LocalEmbedder + chat; async store/stats; retire Ollama client"
```

---

## Task 11: Update callers for async `stats()`

**Files:**
- Modify: `packages/sre-agent/src/cli/crawl.ts`
- Modify: `packages/sre-agent/src/doctor.ts`
- Test: `packages/sre-agent/tests/crawl-cli.test.ts` (verify still green; await tolerates plain objects)

- [ ] **Step 1: Update `runCrawl`**

In `packages/sre-agent/src/cli/crawl.ts`, both places that call `runtime.knowledge.stats()` must `await` it. Change:
```ts
      log(`[crawl] index stats: ${JSON.stringify(runtime.knowledge.stats())}`);
```
(the `--status` branch) and the post-crawl stats line to:
```ts
      log(`[crawl] index stats: ${JSON.stringify(await runtime.knowledge.stats())}`);
```
(`runCrawl` is already `async`, so `await` is valid.)

- [ ] **Step 2: Update the doctor check**

In `packages/sre-agent/src/doctor.ts`, make `checkKnowledge` async and await stats:
```ts
const checkKnowledge = async (): Promise<CheckResult> => {
  try {
    const rt = createMcpRuntime();
    const s = await rt.knowledge.stats();
    rt.knowledge.close?.();
    return { name: "Knowledge index", ok: true, detail: `pages=${s.pages}, chunks=${s.chunks}, model=${s.model ?? "?"}` };
  } catch (e) {
    return {
      name: "Knowledge index",
      ok: false,
      detail: "embed model / sqlite-vec unavailable",
      fix: e instanceof Error ? e.message : String(e)
    };
  }
};
```
and update its call site in `runChecks` (inside the `if (config) { … }` block) from `results.push(checkKnowledge());` to:
```ts
    results.push(await checkKnowledge());
```

- [ ] **Step 3: Run the affected agent tests**

Run: `npx vitest run --project sre-agent crawl-cli doctor`
Expected: PASS. (`crawl-cli.test.ts` fakes `stats` as a sync function; `await` on its return is harmless. If the doctor test stubs `createMcpRuntime`, ensure its `knowledge.stats` is awaitable — a plain object is fine.)

- [ ] **Step 4: Build the agent**

Run: `npm run build --workspace @sre/sre-agent`
Expected: tsc succeeds.

- [ ] **Step 5: Commit**

```bash
git add packages/sre-agent/src/cli/crawl.ts packages/sre-agent/src/doctor.ts
git commit -m "refactor(agent): await async knowledge.stats() in CLI + doctor"
```

---

## Task 12: Docs — replace the Ollama crawl block

**Files:**
- Modify: `packages/sre-agent/.env.example`
- Modify: `packages/sre-agent/README.md`

- [ ] **Step 1: Update `.env.example`**

In `packages/sre-agent/.env.example`, replace the knowledge-crawler block's model lines. Remove `EMBED_BASE_URL` and `CRAWL_LLM_MODEL`; set the new ones:

```bash
# ── Knowledge crawler (internal docs → semantic index) ───────────────────────
# Embeddings run locally in-process (transformers.js / ONNX) — NO Ollama, works
# in both seat and BYOK chat modes. The crawl relevance "verdict" reuses your
# LLM_* config: BYOK → the provider's chat API; seat → heuristic crawl (index
# everything in-scope, no per-page LLM call).
KNOWLEDGE_DB_PATH=                                   # default ~/.sre-agent/knowledge.db
CRAWL_SEEDS=                                         # comma list of seed URLs; required for `crawl`
CRAWL_ALLOW_DOMAINS=                                 # comma list of hosts; default = hosts of seeds
CRAWL_MAX_PAGES=200
CRAWL_MAX_DEPTH=3
CRAWL_CONCURRENCY=4                                  # reserved (crawl is sequential in v1)
CRAWL_RATE_MS=500
CRAWL_MAX_BYTES=2097152
CRAWL_PROXY=                                         # optional http(s) proxy for crawl + verdict traffic
CRAWL_RESPECT_ROBOTS=true
CRAWL_TOPIC=                                         # optional relevance anchor (BYOK verdict only)
EMBED_MODEL=Xenova/bge-small-en-v1.5                 # local embedding model id (dim pinned in the index)
EMBED_MODEL_PATH=                                    # optional: local model dir for fully offline use (no HF download)
```

- [ ] **Step 2: Update README**

In `packages/sre-agent/README.md`, replace the "Knowledge crawler" section body with:

```markdown
### Knowledge crawler

Build a semantic index of internal docs the agent can search. Works regardless of
your chat LLM mode (seat or BYOK) and needs **no Ollama**:

- **Embeddings** run locally in-process (transformers.js / ONNX, `EMBED_MODEL`,
  default `Xenova/bge-small-en-v1.5`). For locked-down networks set
  `EMBED_MODEL_PATH` to a vendored model directory (no Hugging Face download).
- **Crawl verdict** (which pages/links matter) reuses your `LLM_*` config:
  - **BYOK** → the provider's chat API (openai/azure/anthropic).
  - **Seat (Copilot)** → heuristic crawl: index every in-scope page and follow
    all in-scope links (no per-page Copilot calls).

Usage:
1. Set `CRAWL_SEEDS` (and optionally `CRAWL_ALLOW_DOMAINS`, `CRAWL_TOPIC`).
2. Full ingest: `sre-agent crawl` (or `--seed <url>`); status: `sre-agent crawl --status`.
3. In chat: `search_knowledge` retrieves; `index_url` does a small on-demand top-up.

Embeddings are stored in a single SQLite + sqlite-vec file (`KNOWLEDGE_DB_PATH`).
Changing `EMBED_MODEL` after a crawl requires deleting the index (embedding dim is
pinned per model).
```

- [ ] **Step 3: Commit**

```bash
git add packages/sre-agent/.env.example packages/sre-agent/README.md
git commit -m "docs(agent): crawler is LLM-agnostic + local embeddings (no Ollama)"
```

---

## Task 13: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Build all workspaces**

Run: `npm run build`
Expected: `@sre/core`, `@sre/mcp-server`, `@sre/sre-agent` all compile, no tsc errors, no dangling `LlmClient`/`OllamaClient`/`embedBaseUrl`/`crawlModel` references.

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: all suites pass. The `llm.test.ts` is gone; `embedder`, `chat-openai`, `chat-anthropic`, `chat-factory` are new; `crawl`/`search`/`config.knowledge` updated. If a test fails, fix the implementation (not the test) unless the test encodes a wrong expectation.

- [ ] **Step 3: Grep for leftover Ollama references**

Run: `grep -rniE "ollama|embedBaseUrl|crawlModel|OllamaClient|LlmClient" packages/*/src | grep -v node_modules`
Expected: no matches (the feature is Ollama-free). If any remain, resolve them.

- [ ] **Step 4: CLI smoke — store opens with the local model's dim**

Run (uses the real embed model — first run downloads it unless `EMBED_MODEL_PATH`/HF cache is present; allow time):
```bash
SERVICENOW_BASE_URL=https://x.service-now.com SERVICENOW_USERNAME=u SERVICENOW_PASSWORD=p \
  node packages/sre-agent/dist/cli/index.js crawl --status
```
Expected: prints index stats JSON with `model: "Xenova/bge-small-en-v1.5"` and a numeric `dim` (e.g. 384) — NOT the old `nomic-embed-text`/768. A model-load/network error here (locked-down net without `EMBED_MODEL_PATH`) is acceptable as long as it's a clear message, not a crash; note it for the user.

- [ ] **Step 5: Final commit (if any verification fixups were made)**

```bash
git add -A
git commit -m "test: fixups from LLM-agnostic crawler verification"
```

---

## Notes for the implementer

- **Intermediate commits (Tasks 2–9) won't fully `tsc -b`.** Removing `LlmClient` (Task 2) breaks `llm.ts`/`crawl.ts`/`search.ts` until they're updated/deleted (Tasks 8/9/10). This is expected for a cross-file refactor on an unmerged branch. Per-task `npx vitest run --project core <filter>` still passes because vitest transpiles per-file (esbuild) without cross-file type-checking. Full `tsc -b` green is required only at **Task 10 Step 4** (core) and **Task 13** (all workspaces). Reviewers: do not flag the broken whole-package build between Tasks 2 and 10.
- **Existing index incompatibility:** a `~/.sre-agent/knowledge.db` created by the old Ollama build (768-dim) will trip the store's dim/model guard against the new 384-dim local model — that's the intended "delete the index and re-crawl" behavior. For the Step 4 smoke on a dev box, if an old DB exists, delete it first (`rm ~/.sre-agent/knowledge.db`).
- **`stats()` is now async** — the only callers are `runCrawl` (already async) and `doctor.checkKnowledge` (Task 11 makes it async). The agent/mcp tools call `search`/`crawl` (already async) and are unaffected.
- **Unit tests never load a real model** — the embedder is faked at the `CrawlDeps.embedder`/`search` seam, and `embedder.test.ts` mocks `@huggingface/transformers`. Only the Task 13 Step 4 smoke touches a real model.
- **Two config loaders** (`core/config.ts` and `sre-agent/config.ts`) now both read `LLM_*`. This is pre-existing overlap; keep them independent (no import across the boundary). The agent's seat-auth logic is unchanged; core only reads `LLM_*` to derive `knowledge.chat`.
- **Azure body includes `model`** even though the deployment is in the URL — Azure ignores it; kept for one code path. Do not special-case it out.
