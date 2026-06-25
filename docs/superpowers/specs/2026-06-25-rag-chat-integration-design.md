# RAG Chat Integration (search_knowledge in chat + workflows) — Design

- **Date:** 2026-06-25
- **Status:** Approved (design); pending implementation plan
- **Scope:** Make the agent chat actually use the knowledge index (RAG) instead of leaving it entirely to the model's discretion.
- **Builds on:** the crawler + `search_knowledge` tool (`2026-06-24-internal-smart-crawler-design.md`) and the LLM-agnostic refactor (`2026-06-24-llm-agnostic-crawler-design.md`).

## 1. Problem

Today the chat can use the knowledge index only via the `search_knowledge` tool, and nothing steers the model toward it: `engine.ts` sets no system prompt, and the four workflow prompts (`/triage`, `/review`, `/postmortem`, `/handover`) never mention it. So retrieval happens only if the model spontaneously decides the tool fits — unreliable, especially on weaker BYOK models.

Two complementary nudges:
- **#1 — system-prompt nudge:** instruct the model (every session, seat + BYOK) to call `search_knowledge` for how-to / procedure / known-fix questions.
- **#2 — workflow wiring:** add an explicit `search_knowledge` step to all four workflow seed prompts.

## 2. Decisions

| Axis | Decision |
|------|----------|
| #1 injection | Copilot SDK `SessionConfig.systemMessage = { mode: "append", content }` — appends after SDK-managed sections, **keeps all SDK guardrails** (not `replace`); provider-independent (seat + BYOK). |
| #1 gating | Append only when the crawler is configured (`CRAWL_SEEDS` set) — surfaced via a new `AgentConfig.knowledgeEnabled` boolean. No nudge toward an empty index on non-crawler installs. |
| #2 scope | All four workflows: `/triage`, `/postmortem`, `/review`, `/handover`. |
| #2 gating | None — `buildWorkflowPrompt(line)` stays a pure `string → string\|null`. Conditional phrasing + the existing empty-index hint cover the not-configured case. |

## 3. Architecture & components

Small, additive change in three `packages/sre-agent/src/` files; no new modules.

```
packages/sre-agent/src/
  config.ts            # + knowledgeEnabled: boolean (from CRAWL_SEEDS)
  engine/engine.ts     # + KNOWLEDGE_SYSTEM_INSTRUCTION const; append systemMessage when knowledgeEnabled
  workflows/index.ts   # + a search_knowledge step in each of the 4 prompts
```

### Component 1 — system-prompt nudge (`engine/engine.ts`)

- New exported `const KNOWLEDGE_SYSTEM_INSTRUCTION: string` — one short paragraph:
  > "This agent has a `search_knowledge` tool backed by an index of the organization's internal documentation (runbooks, wikis, KB). When the user asks a how-to, procedure, troubleshooting, or known-fix question where internal documentation would help, call `search_knowledge` before answering and cite the returned source URLs. If it returns no results, say the index may be empty and suggest running `sre-agent crawl`. Do not call it for questions clearly answerable from ServiceNow/ADO data alone."
- In `ChatEngine.start()`, when `this.deps.config.knowledgeEnabled` is true, add to the `SessionConfig` object literal:
  ```ts
  systemMessage: { mode: "append", content: KNOWLEDGE_SYSTEM_INSTRUCTION }
  ```
  When false, omit the field entirely (no append). This composes with the existing seat/BYOK `provider` wiring (orthogonal fields).
- `mode: "append"` is mandatory here — `replace` "removes all SDK guardrails including security restrictions" (per the SDK types). We graft, not rebuild.

### Component 2 — config flag (`config.ts`)

- `AgentConfig` gains `knowledgeEnabled: boolean`.
- `loadAgentConfig(env)` sets it by reading `CRAWL_SEEDS` **directly from the `env` map** it already receives (no zod-schema change): `knowledgeEnabled = !!(env.CRAWL_SEEDS && env.CRAWL_SEEDS.trim())`. `CRAWL_SEEDS` continues to flow through to `core`'s loader unchanged; the agent loader only needs the boolean.

### Component 3 — workflow steps (`workflows/index.ts`)

Add one tailored `search_knowledge` instruction to each prompt body (pure-function preserved):

| Workflow | Step (woven into the existing structure) |
|---|---|
| `/triage` | Root-cause + immediate-actions: "If internal runbooks are indexed, use `search_knowledge` to find runbooks or known fixes for these symptoms and cite the source URLs." |
| `/postmortem` | Root-cause + action items: "Use `search_knowledge` to check for an existing runbook or known issue, and flag any runbook gaps as action items." |
| `/review` | Implementation-plan + recommendations: "Use `search_knowledge` for relevant change/deployment standards or procedures for the affected service." |
| `/handover` | Tool list: "Use `search_knowledge` for runbooks relevant to the active incidents the next shift may need." |

## 4. Why the two halves are complementary

- #1 raises the baseline: across **every** session and free-form question, the model reaches for the index when internal docs would help.
- #2 guarantees it at high-value structured moments: the `/triage`-style flows explicitly consult the index at the right step.
Not redundant — one is ambient, the other is deterministic for the workflows.

## 5. Error handling

No new runtime surface. The system message is a benign static append; when `knowledgeEnabled` is false it is omitted. Workflow edits are static strings. An empty index is already handled by `search_knowledge` returning the "run `sre-agent crawl`" hint, which both nudges now reference.

## 6. Testing (vitest, TDD)

- `tests/config.test.ts` — `loadAgentConfig` sets `knowledgeEnabled` true when `CRAWL_SEEDS` is set, false when absent/empty.
- `tests/engine.test.ts` — extend the existing fake-client `createSession` capture: with `knowledgeEnabled: true`, the captured `SessionConfig.systemMessage` equals `{ mode: "append", content }` where `content` contains `search_knowledge`; with `knowledgeEnabled: false`, `systemMessage` is `undefined`. Assert this holds in both seat and BYOK config variants (orthogonal to `provider`).
- `tests/workflows.test.ts` — each of the four prompts (`/triage`, `/postmortem`, `/review`, `/handover`) contains `search_knowledge`.
- Full `npm run build` (all workspaces) + `npm test` green.

## 7. Out of scope / future

- Forced pre-retrieval RAG (always embed the question and inject top-k chunks before the model answers) — explicitly NOT done; this design keeps retrieval model-driven via the tool, only better-steered.
- A separate `KNOWLEDGE_PROMPT` on/off env toggle — `knowledgeEnabled` (derived from `CRAWL_SEEDS`) is sufficient; a manual override can be added later if needed.
- Reranking / citation formatting changes — unchanged.
