# Handoff — Internal Knowledge Crawler + RAG Chat Integration

- **Date:** 2026-06-26
- **Branch:** all work merged to `main` and pushed to `origin/main` (head `e60b055`).
- **State:** `npm run build` green (all 3 workspaces); `npm test` green (**244 tests**).
- **Scope of this work:** added a local, LLM-agnostic documentation crawler to the SRE agent, wired its index into the chat as agentic RAG, and documented all of it.

---

## 1. What was delivered (in order)

### A. Investigation — Ollama via BYOK (no code)
Confirmed empirically that the agent's existing **BYOK** path runs a local Ollama with **zero GitHub auth** and the bundled `@github/copilot` runtime has native Ollama support (`connection_refused_ollama`, `/chat/completions`, `wireApi`). A direct `CopilotClient` probe with an empty credential store + `useLoggedInUser:false` booted, created a session, and reached the provider (`isAuthenticated:false`). Conclusion: the GitHub runtime boots credential-free; GitHub identity is only needed for *seat-mode* inference. (This motivated, but is independent of, the crawler work below.)

### B. Internal smart crawler — merge `c4d8621`
LLM-guided crawler over internal docs feeding a semantic index.
- **Pipeline in `@sre/core`:** `clients/crawler/{fetcher,extract,robots,robotsClient}` + `services/knowledge/{chunk,store,crawl,search,verdict,index}`.
- **Store:** SQLite + `sqlite-vec` (single file, `KNOWLEDGE_DB_PATH`, default `~/.sre-agent/knowledge.db`), dim pinned per embed model.
- **Crawl:** LLM-guided BFS — one combined relevance + link-keep verdict per page; content extraction (readability) → chunk → embed → upsert. Bounded by `CRAWL_MAX_PAGES`/`MAX_DEPTH`, scoped to `CRAWL_ALLOW_DOMAINS`, robots-aware, incremental via content hash.
- **Two run modes, one orchestrator:** `sre-agent crawl` CLI (full) + bounded in-agent `index_url` tool; query via `search_knowledge`. Tools projected in both `sre-agent` and `mcp-server`.
- **Security:** final review caught a seed-level SSRF (seeds bypassed `allowDomains`); fixed — seeds are scope-checked, so the model-supplied `index_url` cannot fetch arbitrary hosts. Also fixed in review: full-chunk-text leak through `search_knowledge` (now snippet-only), robots enforcement (was inert for `text/plain`), `chunks_added` miscount, store model-guard.

### C. LLM-agnostic refactor — local embeddings, no Ollama — merge `2192b8a`
Made the crawler work in **both** agent LLM modes with **zero Ollama dependency**.
- **Embeddings → local, in-process** via `@huggingface/transformers` (ONNX, `clients/embedder.ts` `LocalEmbedder`), default `Xenova/bge-small-en-v1.5` (384-dim). Offline via `EMBED_MODEL_PATH` (vendored model dir, no Hugging Face download). The *only* vector source — neither Copilot-seat nor Anthropic exposes an embeddings API, so embeddings cannot ride the chat LLM.
- **Verdict → pluggable `ChatModel`** (`clients/chat/{types,openai,anthropic,factory}.ts`): BYOK → provider HTTP (`OpenAiChat` covers openai + azure, `AnthropicChat` = Messages API); **seat → heuristic crawl** (identity verdict: index every in-scope page, follow all in-scope links). `knowledge.chat` is derived from the existing `LLM_*` env in `core/config.ts`.
- Retired the Ollama `clients/llm.ts`. `KnowledgeService.stats()` is async (loads the embed model to learn `dim` before opening the store).
- **Native teardown fix:** `onnxruntime-node` aborts (`libc++abi: mutex lock failed`) if the process exits with the ONNX session live. Fixed with `LocalEmbedder.dispose()` + async `KnowledgeService.close()` + using `process.exitCode` (not `process.exit`) on the crawl/doctor paths, and `await close()` on REPL + MCP-server shutdown. Verified: `crawl --status` prints `dim:384` and exits 0, no abort.

### D. RAG chat integration — merge `00282d2`
The `search_knowledge` tool existed but nothing steered the model to it. Two complementary nudges:
1. **System-prompt nudge** (`engine.ts`): `SessionConfig.systemMessage = { mode: "append", content: KNOWLEDGE_SYSTEM_INSTRUCTION }`. Append mode keeps all SDK guardrails; provider-independent (seat + BYOK). **Gated** on `AgentConfig.knowledgeEnabled` (= `CRAWL_SEEDS` set) so non-crawler installs get no nudge.
2. **Workflow steps:** a `search_knowledge` instruction added to all four workflow prompts (`/triage`, `/review`, `/postmortem`, `/handover`).
This is *agentic* RAG (the model decides when to retrieve) — not forced pre-retrieval.

### E. Documentation — commits `add9835`, `e60b055`
- Root `README.md`: new "Knowledge crawler (RAG)" section + crawl commands + a pointer to the tool roster.
- `packages/sre-agent/README.md`: "Tools" section (full 14-tool roster table) + "Chat RAG steering" note in the crawler section.
- `packages/sre-agent/.env.example`: documented that `CRAWL_SEEDS` also enables chat steering.

---

## 2. How to use (quickstart)

```bash
# .env
CRAWL_SEEDS=https://wiki.acme.io/sre, https://kb.acme.io/runbooks
EMBED_MODEL=Xenova/bge-small-en-v1.5        # default; local, 384-dim
# EMBED_MODEL_PATH=/opt/models/bge-small    # set for offline / locked-down networks

npm start -- crawl            # build the index (runs outside any Copilot session)
npm start -- crawl --status   # {pages, chunks, model, dim}
npm start                     # chat; how-to questions + /triage etc. now consult the index
npm start -- doctor           # checks Node/az/Copilot/config + the knowledge index
```

Crawl verdict: BYOK → LLM-guided; seat → heuristic. Embeddings always local. Full reference: `packages/sre-agent/README.md` and `.env.example`.

---

## 3. Verified state

- All work merged to `main`, pushed to `origin/main` (head `e60b055`).
- `npm run build`: clean across `@sre/core`, `@sre/mcp-server`, `@sre/sre-agent`.
- `npm test`: 244 passing.
- `crawl --status` smoke: opens the sqlite-vec store, loads the local model, prints `model: Xenova/bge-small-en-v1.5, dim: 384`, exits 0 (no native abort).
- Each feature went through subagent-driven implementation + a final whole-branch review; review-found defects were fixed before merge.

---

## 4. Known caveats & follow-ups (not done — intentional or deferred)

| Item | Status / note |
|---|---|
| **Offline model provisioning** | First crawl downloads the embed model (~90 MB) from Hugging Face unless `EMBED_MODEL_PATH` is set. The work network that blocks MCP/PATs likely blocks HF Hub → vendor the model dir for real use. |
| **Changing `EMBED_MODEL`** | Requires deleting the index (`rm ~/.sre-agent/knowledge.db*`) and re-crawling — dim is pinned per model (guard throws a clear error otherwise). |
| **`ensureStore()` not race-safe** | Two concurrent `KnowledgeService` calls could double-open the store. Not used concurrently today; possible follow-up (promise-memoize). |
| **MCP server SIGKILL** | The ONNX dispose-on-exit handler covers SIGINT/SIGTERM; a host SIGKILL can't be caught (abort moot since the process is force-killed). |
| **`CRAWL_CONCURRENCY`** | Plumbed through config but the crawl loop is sequential (politeness). Reserved/unwired. |
| **`EMBED_DIM` env override** | Not added — dim is derived from the model. Add if a non-curated embed model is needed. |
| **Forced pre-retrieval RAG** | Out of scope. Current RAG is agentic (tool-driven). If guaranteed retrieval is wanted, the lever is: embed every question → inject top-k chunks before the model answers (larger change). |
| **Two config loaders** | `core/config.ts` and `sre-agent/config.ts` both read `LLM_*` (pre-existing overlap; kept independent — drift risk). |

---

## 5. Where to look

- **Design specs:** `docs/superpowers/specs/2026-06-24-internal-smart-crawler-design.md`, `…/2026-06-24-llm-agnostic-crawler-design.md`, `…/2026-06-25-rag-chat-integration-design.md`.
- **Implementation plans:** `docs/superpowers/plans/2026-06-24-internal-smart-crawler.md`, `…/2026-06-24-llm-agnostic-crawler.md`, `…/2026-06-25-rag-chat-integration.md`.
- **Code:** crawler/RAG live in `packages/core/src/{clients,services/knowledge}`; chat wiring in `packages/sre-agent/src/{engine,workflows,config,cli}`.
- **User docs:** root `README.md`, `packages/sre-agent/README.md`, `packages/sre-agent/.env.example`.
