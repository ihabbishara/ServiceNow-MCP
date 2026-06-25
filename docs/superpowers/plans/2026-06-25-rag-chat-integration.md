# RAG Chat Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Steer the agent chat to actually use the knowledge index — a gated system-prompt nudge (every session, seat + BYOK) plus a `search_knowledge` step in all four workflow prompts.

**Architecture:** Three additive edits in `packages/sre-agent/src/`: a `knowledgeEnabled` flag on `AgentConfig` (from `CRAWL_SEEDS`), a `systemMessage` append in `ChatEngine.start()`'s `SessionConfig` gated on that flag, and a `search_knowledge` instruction woven into each `buildWorkflowPrompt` body. No new modules; no runtime/IO surface.

**Tech Stack:** TypeScript (ESM, NodeNext), `@github/copilot-sdk`, `vitest`. Working in worktree `.worktrees/rag-chat-integration` on branch `feature/rag-chat-integration`.

**Conventions:** ESM `.js` import extensions; run tests/build/git from the worktree root `/Users/ihabbishara/projects/ServiceNowMCP/.worktrees/rag-chat-integration`; no `cd` in compound commands. Run one project: `npx vitest run --project sre-agent <filter>`. Full suite: `npm test`. Build: `npm run build`.

---

## File Structure

**Modify (all under `packages/sre-agent/`):**
- `src/config.ts` — add `knowledgeEnabled: boolean` to `AgentConfig`, set from `CRAWL_SEEDS`.
- `src/engine/engine.ts` — export `KNOWLEDGE_SYSTEM_INSTRUCTION`; append `systemMessage` to `SessionConfig` when `config.knowledgeEnabled`.
- `src/workflows/index.ts` — add a `search_knowledge` instruction to the `/triage`, `/review`, `/postmortem`, `/handover` prompts.
- `tests/config.test.ts`, `tests/engine.test.ts`, `tests/workflows.test.ts` — assertions.

---

## Task 1: `AgentConfig.knowledgeEnabled` from `CRAWL_SEEDS`

**Files:**
- Modify: `packages/sre-agent/src/config.ts`
- Test: `packages/sre-agent/tests/config.test.ts`

- [ ] **Step 1: Write the failing tests**

Append these two tests inside the `describe("loadAgentConfig", ...)` block in `packages/sre-agent/tests/config.test.ts`:

```ts
  it("knowledgeEnabled is false when CRAWL_SEEDS is unset/empty", () => {
    expect(loadAgentConfig({ ...base }).knowledgeEnabled).toBe(false);
    expect(loadAgentConfig({ ...base, CRAWL_SEEDS: "   " }).knowledgeEnabled).toBe(false);
  });

  it("knowledgeEnabled is true when CRAWL_SEEDS is set", () => {
    expect(loadAgentConfig({ ...base, CRAWL_SEEDS: "https://wiki.acme.io/a" }).knowledgeEnabled).toBe(true);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project sre-agent config`
Expected: FAIL — `knowledgeEnabled` is `undefined`.

- [ ] **Step 3: Implement**

In `packages/sre-agent/src/config.ts`, add the field to the `AgentConfig` interface (after `confirmWrites: boolean;`):

```ts
  /** True when the crawler is configured (CRAWL_SEEDS set) → steer chat toward search_knowledge. */
  knowledgeEnabled: boolean;
```

In `loadAgentConfig`, add `knowledgeEnabled` to the returned object (read directly from the `env` param, NOT the parsed `e` — `CRAWL_SEEDS` is not in the agent zod schema and stays owned by core). Add it next to `confirmWrites`:

```ts
    confirmWrites: e.CONFIRM_WRITES,
    knowledgeEnabled: !!(env.CRAWL_SEEDS && String(env.CRAWL_SEEDS).trim()),
```

(`loadAgentConfig(env = process.env)` already has `env` in scope.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project sre-agent config`
Expected: PASS (existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add packages/sre-agent/src/config.ts packages/sre-agent/tests/config.test.ts
git commit -m "feat(agent): knowledgeEnabled config flag from CRAWL_SEEDS"
```

---

## Task 2: System-prompt knowledge nudge in `ChatEngine`

**Files:**
- Modify: `packages/sre-agent/src/engine/engine.ts`
- Test: `packages/sre-agent/tests/engine.test.ts`

- [ ] **Step 1: Write the failing tests**

Add these two tests to `packages/sre-agent/tests/engine.test.ts` inside `describe("ChatEngine clientFactory seam", ...)`. They reuse the existing `makeFakeClient`/`noopDeps`/`base` helpers already in that file:

```ts
  it("appends the knowledge system message when CRAWL_SEEDS is set (seat or byok)", async () => {
    const { client, createSession } = makeFakeClient();
    const config = loadAgentConfig({ ...base, CRAWL_SEEDS: "https://wiki.acme.io/a" });
    const engine = new ChatEngine({ config, tools: [], ...noopDeps, clientFactory: () => client as never });
    await engine.start();
    const sessionConfig = createSession.mock.calls[0][0];
    expect(sessionConfig.systemMessage).toEqual({
      mode: "append",
      content: KNOWLEDGE_SYSTEM_INSTRUCTION
    });
    expect(KNOWLEDGE_SYSTEM_INSTRUCTION).toContain("search_knowledge");
  });

  it("omits systemMessage when the crawler is not configured", async () => {
    const { client, createSession } = makeFakeClient();
    const config = loadAgentConfig({ ...base }); // no CRAWL_SEEDS
    const engine = new ChatEngine({ config, tools: [], ...noopDeps, clientFactory: () => client as never });
    await engine.start();
    const sessionConfig = createSession.mock.calls[0][0];
    expect("systemMessage" in sessionConfig).toBe(false);
  });
```

Also update the import at the top of `engine.test.ts` to pull in the new export:

```ts
import { ChatEngine, buildClientOptions, KNOWLEDGE_SYSTEM_INSTRUCTION } from "../src/engine/engine.js";
```

(The file currently imports `{ ChatEngine, buildClientOptions }` — add `KNOWLEDGE_SYSTEM_INSTRUCTION`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project sre-agent engine`
Expected: FAIL — `KNOWLEDGE_SYSTEM_INSTRUCTION` is not exported; `systemMessage` not set.

- [ ] **Step 3: Implement**

In `packages/sre-agent/src/engine/engine.ts`, add the exported constant near the top (after the imports, before `export const buildClientOptions`):

```ts
/**
 * Appended to the Copilot session's system message (append mode → keeps all SDK
 * guardrails) when the crawler is configured. Steers the model to consult the
 * internal-docs index via the `search_knowledge` tool for how-to/runbook
 * questions, in both seat and BYOK modes.
 */
export const KNOWLEDGE_SYSTEM_INSTRUCTION =
  "This agent has a `search_knowledge` tool backed by an index of the organization's internal " +
  "documentation (runbooks, wikis, KB). When the user asks a how-to, procedure, troubleshooting, " +
  "or known-fix question where internal documentation would help, call `search_knowledge` before " +
  "answering and cite the returned source URLs. If it returns no results, say the index may be empty " +
  "and suggest running `sre-agent crawl`. Do not call it for questions clearly answerable from " +
  "ServiceNow/ADO data alone.";
```

In `ChatEngine.start()`, add a gated `systemMessage` to the `sessionConfig` object literal. Insert it right after the `onPermissionRequest: permissionHandler,` line and before the `...(cfg.llm.mode === "byok" ...)` provider spread:

```ts
        onPermissionRequest: permissionHandler,
        ...(cfg.knowledgeEnabled
          ? { systemMessage: { mode: "append" as const, content: KNOWLEDGE_SYSTEM_INSTRUCTION } }
          : {}),
        ...(cfg.llm.mode === "byok" && cfg.llm.provider
```

(`cfg` is `this.deps.config`. The `as const` pins `mode` to the `"append"` literal so it satisfies the SDK's `SystemMessageAppendConfig` discriminated union.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project sre-agent engine`
Expected: PASS (existing seat/BYOK tests + 2 new).

- [ ] **Step 5: Commit**

```bash
git add packages/sre-agent/src/engine/engine.ts packages/sre-agent/tests/engine.test.ts
git commit -m "feat(agent): append knowledge system-prompt nudge when crawler configured"
```

---

## Task 3: `search_knowledge` step in all four workflow prompts

**Files:**
- Modify: `packages/sre-agent/src/workflows/index.ts`
- Test: `packages/sre-agent/tests/workflows.test.ts`

- [ ] **Step 1: Write the failing test**

Add this test to `packages/sre-agent/tests/workflows.test.ts` inside `describe("workflows", ...)`:

```ts
  it("every workflow prompt steers the model to search_knowledge", () => {
    expect(buildWorkflowPrompt("/triage INC1")).toContain("search_knowledge");
    expect(buildWorkflowPrompt("/review CHG1")).toContain("search_knowledge");
    expect(buildWorkflowPrompt("/postmortem INC1")).toContain("search_knowledge");
    expect(buildWorkflowPrompt("/handover Platform SRE")).toContain("search_knowledge");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project sre-agent workflows`
Expected: FAIL — none of the prompts mention `search_knowledge`.

- [ ] **Step 3: Implement the four edits**

In `packages/sre-agent/src/workflows/index.ts`:

**(a) `triagePrompt`** — replace:
```ts
First, use the summarize_incident tool to get full context including related changes.
```
with:
```ts
First, use the summarize_incident tool to get full context including related changes.

If internal documentation is indexed, also call search_knowledge to find runbooks or known fixes for these symptoms, and cite the source URLs in your recommendations.
```

**(b) `reviewPrompt`** — replace:
```ts
First, use get_change to get the full change details.
```
with:
```ts
First, use get_change to get the full change details.

If internal documentation is indexed, call search_knowledge for relevant change or deployment standards and procedures for the affected service.
```

**(c) `postmortemPrompt`** — replace:
```ts
First, use summarize_incident to get full context including timeline and related changes.
```
with:
```ts
First, use summarize_incident to get full context including timeline and related changes.

Also call search_knowledge to check for an existing runbook or known issue for this failure, and flag any runbook gaps as action items.
```

**(d) `handoverPrompt`** — the tool list is numbered 1–4 (`search_incidents`, `find_sla_risks`, `find_stale_tickets`, `search_changes`). Replace the last item:
```ts
4. search_changes - find changes in the time period
```
with:
```ts
4. search_changes - find changes in the time period
5. search_knowledge - find runbooks relevant to the active incidents the next shift may need
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project sre-agent workflows`
Expected: PASS (existing 7 + 1 new). The existing assertions (`summarize_incident`, `get_change`, `Platform SRE`, `8 hours`, etc.) still hold — the edits are additive.

- [ ] **Step 5: Commit**

```bash
git add packages/sre-agent/src/workflows/index.ts packages/sre-agent/tests/workflows.test.ts
git commit -m "feat(agent): consult search_knowledge in triage/review/postmortem/handover"
```

---

## Task 4: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Build all workspaces**

Run: `npm run build`
Expected: `@sre/core`, `@sre/mcp-server`, `@sre/sre-agent` all compile, no tsc errors (notably the `systemMessage` literal type-checks against the SDK's `SystemMessageConfig`).

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: all suites pass (existing + the new config/engine/workflows assertions). If a test fails, fix the implementation (not the test) unless the test encodes a wrong expectation.

- [ ] **Step 3: Sanity grep**

Run: `grep -rn "search_knowledge" packages/sre-agent/src/workflows/index.ts; grep -rn "KNOWLEDGE_SYSTEM_INSTRUCTION\|systemMessage" packages/sre-agent/src/engine/engine.ts`
Expected: four `search_knowledge` mentions in workflows; the constant + a gated `systemMessage` in engine.

- [ ] **Step 4: Final commit (only if verification fixups were made)**

```bash
git add -A
git commit -m "test: fixups from RAG chat integration verification"
```

---

## Notes for the implementer

- **`knowledgeEnabled` reads the raw `env`, not the zod-parsed `e`.** `CRAWL_SEEDS` is owned by `core`'s config loader and is intentionally NOT added to the agent's zod schema — the agent only needs the boolean. Reading `env.CRAWL_SEEDS` directly keeps the schemas independent (no new drift).
- **`mode: "append"` is mandatory.** The SDK's `replace` mode "removes all SDK guardrails including security restrictions". Append grafts our nudge after the managed sections.
- **Gating is #1 only.** The workflow edits (Task 3) are unconditional — `buildWorkflowPrompt` stays a pure `string → string|null`. Conditional phrasing ("if internal documentation is indexed") plus the tool's empty-index hint covers the not-configured case.
- **No runtime/IO change** — these are static config/prompt additions. No model is loaded, no network touched; the full suite stays offline and fast.
