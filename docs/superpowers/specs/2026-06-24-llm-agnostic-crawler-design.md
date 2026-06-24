# LLM-Agnostic Crawler (Local Embeddings, No Ollama) — Design

- **Date:** 2026-06-24
- **Status:** Approved (design); pending implementation plan
- **Scope:** Refactor the internal smart crawler so it works regardless of the agent's LLM mode (seat or BYOK) with **zero Ollama dependency**.
- **Supersedes the LLM wiring of:** `2026-06-24-internal-smart-crawler-design.md` (the crawler exists on `main`; this changes how its LLM/embedding capabilities are sourced).

## 1. Problem

The shipped crawler routes both its chat (relevance/link verdict) and its embeddings through a single `OllamaClient` (an OpenAI-compatible HTTP endpoint). That makes the crawler depend on a running Ollama (or equivalent) endpoint, decoupled from how the agent's chat is configured. Requirement: the crawler must work with **both** chat modes the agent supports — **seat** (GitHub Copilot) and **BYOK** (azure/anthropic/openai) — and have **no Ollama dependency whatsoever**.

**Hard facts that force the design:**
- The GitHub Copilot SDK exposes **no public embeddings API** (`embedding*` fields in the SDK are internal retrieval-cache config only; there is no `client.embed()`).
- Among BYOK providers, **Anthropic has no embeddings API**.
- Therefore embeddings **cannot** ride on "the configured LLM" universally. They must be decoupled from the chat LLM.

## 2. Decisions

| Axis | Decision |
|------|----------|
| Embeddings | **Local in-process** (ONNX via transformers.js). Universal, offline-capable, zero external service. |
| Verdict (relevance + link-keep) | **BYOK → provider HTTP; seat → heuristic** (no per-page Copilot turns; core stays SDK-free). |
| Retrieval | Semantic (local embeddings) in **both** modes. |
| Ollama | Removed entirely (`clients/llm.ts` retired). |

## 3. Architecture & components

The crawler's LLM surface splits into **two independent, pluggable capabilities**, replacing the single `LlmClient {chat, embed}`:

- `Embedder` — `embed(text) → number[]`, `dim`, `model`, `ready()`. One impl: `LocalEmbedder`.
- `ChatModel` — `chat(prompt) → string`. Built from the agent's BYOK provider config; `undefined` in seat mode.

```
core/src/clients/
  embedder.ts          # NEW: LocalEmbedder — in-process ONNX (transformers.js)
  chat/
    types.ts           # NEW: ChatModel interface
    openai.ts          # NEW: OpenAI-compatible chat (byok openai + azure)
    anthropic.ts       # NEW: Anthropic Messages API chat (byok anthropic)
    factory.ts         # NEW: makeChatModel(chatCfg?, proxyUrl) -> ChatModel | undefined
  llm.ts               # REMOVED (Ollama client retired)
core/src/services/knowledge/
  crawl.ts             # CHANGED: deps.embedder (required) + deps.chat? (optional)
  search.ts            # CHANGED: uses embedder.embed
  store.ts             # CHANGED: dim sourced from embedder; EMBED_DIMS authority map removed
  index.ts (facade)    # CHANGED: builds LocalEmbedder + makeChatModel(cfg.chat); wires both
core/src/config.ts     # CHANGED: KnowledgeConfig (embedder + chat) from existing LLM_* env
```

**Crawl behavior by mode (both keep local-embedding semantic retrieval):**

| Agent LLM mode | Verdict | Embeddings |
|---|---|---|
| BYOK (openai/azure/anthropic) | LLM verdict via provider HTTP | local |
| Seat (Copilot) | heuristic — index every in-domain page, follow all in-scope links | local |

Rationale: chat and embeddings have opposite availability (chat is nearly universal; embeddings exist nowhere universal). Splitting lets each degrade independently — embeddings never degrade (always local); chat degrades to heuristic only where truly absent (seat).

## 4. Local embedder

**Library:** `@huggingface/transformers` (transformers.js) — JS + WASM backend (no native compile required for the wasm path), optional `onnxruntime-node` for speed. CPU feature-extraction pipeline.

**`LocalEmbedder` (`clients/embedder.ts`):**
```ts
class LocalEmbedder implements Embedder {
  readonly model: string;        // e.g. "Xenova/bge-small-en-v1.5"
  dim: number;                   // learned on first load (output length), then fixed
  async ready(): Promise<void>;  // loads the pipeline once, sets dim
  async embed(text: string): Promise<number[]>; // mean-pooled + L2-normalized
}
```
- Lazy-loads the pipeline once per process; `ready()` forces the load so `dim` is known before the store opens.
- Default model `Xenova/bge-small-en-v1.5` (384-dim), configurable via `EMBED_MODEL`.
- Mean-pool + L2-normalize so cosine distance in sqlite-vec is meaningful.

**Offline provisioning (internal/locked-down networks — the same networks that blocked MCP + PATs likely block HF Hub):**
- `EMBED_MODEL_PATH` (optional) → locally-vendored model directory. When set: `env.allowRemoteModels = false` + `env.localModelPath = <dir>` → **zero network**.
- When unset: transformers.js downloads once from HF Hub and caches (`HF_HOME`/default cache). Acceptable for dev/open networks.
- `doctor` reports the active path and whether the model loaded.

**Dim coupling:** the embedder is the authority for `dim`. `KnowledgeService` calls `await embedder.ready()` before opening the store, then passes `{model, dim}` to `KnowledgeStore`. The store's model+dim meta-pin and mismatch guard are preserved (so changing `EMBED_MODEL` still forces an index rebuild — no silent vector-space mixing). The hardcoded `EMBED_DIMS` authority map is removed (a small known-dims table may remain only as a doctor/error hint).

## 5. Verdict chat (BYOK-HTTP, seat→heuristic)

**`ChatModel`:** `chat(prompt: string): Promise<string>`.

**`makeChatModel(cfg?, proxyUrl)`:**

| `cfg.type` | Endpoint | Body | Auth | Parse |
|---|---|---|---|---|
| `openai` | `${baseUrl}/chat/completions` | `{model, messages:[{role:"user",content}], temperature:0}` | `Authorization: Bearer` | `choices[0].message.content` |
| `azure` | `${baseUrl}/openai/deployments/${model}/chat/completions?api-version=${apiVersion}` | same as openai | `api-key` header (or Bearer) | same |
| `anthropic` | `${baseUrl}/v1/messages` | `{model, max_tokens, messages:[{role:"user",content}]}` + `anthropic-version` header | `x-api-key` | `content[0].text` |
| none (seat) | — | — | — | returns `undefined` → heuristic |

All over `undici` + `proxyDispatcher` (reuses `proxy.ts`). `openai.ts` is the OpenAI-compatible chat (the retired `OllamaClient.chat` logic), so a self-hosted OpenAI-compatible endpoint remains a valid BYOK target.

**Config wiring — reuse the agent's existing `LLM_*` env (no new chat config):**
`core/config.ts` builds `knowledge.chat`:
- `LLM_MODE=byok` + `LLM_PROVIDER` + `LLM_BASE_URL` → `chat = {type: LLM_PROVIDER, baseUrl: LLM_BASE_URL, apiKey: LLM_API_KEY, model: LLM_MODEL, apiVersion: AZURE_API_VERSION}`.
- `LLM_MODE=seat` or no provider → `chat = undefined` → heuristic.

This deepens the existing two-loader env overlap (`core/config.ts` and `sre-agent/config.ts` both read `LLM_*`) — accepted; both read the same vars independently, no schema crosses the boundary.

**Heuristic fallback in `crawl.ts`:** `deps.chat?` is optional.
- present → `buildVerdictPrompt` → `chat.chat()` → `parseVerdict` (existing fail-soft on bad JSON stays).
- absent → identity verdict `{relevant: true, keepLinks: doc.links}` — index every page, enqueue all links. The existing `inScope` (incl. the seed scope-check security fix), depth, `seen`, and `maxPages` gates still bound it.

The heuristic is the identity verdict fed through the **same** downstream pipeline (chunk→embed→store, enqueue-with-scope) — seat and BYOK crawls differ by one value, not by branching logic. The orchestrator stays single-path.

## 6. Config summary

`KnowledgeConfig` after refactor:
- **Removed:** `embedBaseUrl`, `crawlModel`.
- **Changed:** `embedModel` is now a local model id (default `Xenova/bge-small-en-v1.5`).
- **Added:** `embedModelPath?` (from `EMBED_MODEL_PATH`), `chat?: {type:"openai"|"azure"|"anthropic", baseUrl, apiKey?, model, apiVersion?}`.
- **Kept:** `dbPath`, `seeds`, `allowDomains`, `maxPages`, `maxDepth`, `concurrency`, `rateMs`, `maxBytes`, `proxyUrl`, `respectRobots`, `topic`.
- **Removed env:** `EMBED_BASE_URL`, `CRAWL_LLM_MODEL`. `LLM_*` (mode/provider/base-url/api-key/model/api-version) now also feed `knowledge.chat`.

## 7. Testing (vitest; deps injected — no model downloads in unit tests)

- `crawl.test.ts` — add heuristic case: `deps.chat = undefined` → every fetched in-scope page indexed + all in-scope links enqueued, `chat` never called. Keep BYOK-verdict cases (fake `chat`).
- `chat/openai.test.ts`, `chat/anthropic.test.ts` — undici-mock (`vi.mock("undici")` pattern), assert endpoint/headers/body shape + parse.
- `chat/factory.test.ts` — `type` → correct client; no cfg → `undefined`.
- `embedder.test.ts` — mock the transformers pipeline; assert mean-pool/normalize + dim capture (no real model load).
- `search.test.ts`, facade test, `config.knowledge.test.ts` — updated for embedder + `knowledge.chat` derivation (byok→set, seat→undefined).
- **Delete** `llm.test.ts`.
- Full `npm run build` + suite green; `crawl --status` smoke.

## 8. Migration off Ollama

- Delete `clients/llm.ts` + `llm.test.ts`; add embedder + chat clients + factory.
- An existing `knowledge.db` built with old Ollama embeddings (e.g. 768-dim `nomic-embed-text`) is incompatible with the new local model (e.g. 384-dim `bge-small`) → the store's dim/model guard throws a clear "delete the index / revert EMBED_MODEL" error. Low real impact (feature just shipped; unlikely any populated index exists). `doctor` + README: rebuild the index after this change.
- `.env.example` + README: replace the Ollama crawl block with local-embed (+ `EMBED_MODEL_PATH` offline note) and "verdict follows your `LLM_*` config; seat = heuristic crawl."

## 9. Out of scope / future

- BYOK Anthropic embeddings via a separate embeddings provider (Voyage etc.) — not needed; embeddings are always local.
- Remote/hosted embeddings option — explicitly rejected in favor of local-only (zero external embed dependency).
- Native `onnxruntime-node` acceleration is optional; default wasm path is the baseline.
- Parallel crawl (`concurrency`) remains reserved/unwired (sequential), unchanged by this work.
