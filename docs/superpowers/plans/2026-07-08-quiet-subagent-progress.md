# Quiet Code Analyser Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Code Analyser's per-tool step timeline with a single labeled "analysing the code…" indicator (CLI + web), keeping the sub-agent identity and a one-line transcript trace; the engine is untouched.

**Architecture:** Presentation-only. The engine keeps emitting `SubAgentEvent` (`start`/`tool`/`done`/`error`); the two consumers — the CLI `onSubAgent` handler and the web client reducer/view — ignore `tool` and render a labeled status instead of a growing step list.

**Tech Stack:** TypeScript, React (web client), vitest.

**Spec:** `docs/superpowers/specs/2026-07-08-quiet-subagent-progress-design.md`

## Global Constraints

- Identity preserved: the running indicator always names the agent — `🔬 <agent> is analysing the code…` — never a generic "Thinking…".
- `tool` phase produces NO output on either surface.
- Engine and `SubAgentEvent` are untouched — no edits under `packages/sre-agent/src/engine/` or its tests.
- CLI lines: start → `🔬 <agent> is analysing the code…`; done → `🔬 <agent>: report ready (<detail>)`; error → `🔬 <agent>: failed: <detail>`.
- Web: `SubAgentActivity` loses `steps`, gains nothing except an optional duration carried on the live block; folded transcript line shows `report ready (<duration>)` or `failed: <error>`.
- Run from repo root `/Users/ihabbishara/projects/ServiceNowMCP`; lint-clean before commit.

---

### Task 1: Web state — drop `steps`, status reducer

**Files:**
- Modify: `packages/web/client/src/state.ts` (`SubAgentActivity` line 4-8, `ChatMessage.activity` comment line 14, `foldActivity` line 55-77, `subagent-status` reducer line 148-173)
- Test: `packages/web/tests/state.test.ts` (rewrite the `subagent activity block` describe, lines 130-202)

**Interfaces:**
- Consumes: `ServerEvent` `subagent-status` (`{ phase: "start"|"tool"|"done"|"error"; agent; detail? }`).
- Produces (Task 2 consumes):
  - `SubAgentActivity = { agent: string; error?: string }`
  - `ChatState.subagent?: SubAgentActivity & { done: boolean; duration?: string }`
  - `ChatMessage.activity?: SubAgentActivity & { duration?: string }`

- [ ] **Step 1: Rewrite the failing tests**

Replace the entire `describe("subagent activity block", …)` block (lines 130-202) in `packages/web/tests/state.test.ts` with:

```ts
describe("subagent status block", () => {
  const seq = (events: Parameters<typeof applyServerEvent>[1][]) =>
    events.reduce(applyServerEvent, initialState);

  it("sets a labeled block on start and ignores tool events", () => {
    const s = seq([
      { type: "subagent-status", phase: "start", agent: "Code Analyser" },
      { type: "subagent-status", phase: "tool", agent: "Code Analyser", detail: 'search_repo — "x"' }
    ]);
    expect(s.subagent).toEqual({ agent: "Code Analyser", done: false });
  });

  it("marks done with a duration", () => {
    const s = seq([
      { type: "subagent-status", phase: "start", agent: "Code Analyser" },
      { type: "subagent-status", phase: "done", agent: "Code Analyser", detail: "34s" }
    ]);
    expect(s.subagent).toEqual({ agent: "Code Analyser", done: true, duration: "34s" });
  });

  it("records error phase", () => {
    const s = seq([
      { type: "subagent-status", phase: "start", agent: "Code Analyser" },
      { type: "subagent-status", phase: "error", agent: "Code Analyser", detail: "clone failed" }
    ]);
    expect(s.subagent).toMatchObject({ agent: "Code Analyser", error: "clone failed", done: true });
  });

  it("ignores tool/done/error without a preceding start", () => {
    expect(seq([{ type: "subagent-status", phase: "tool", agent: "X", detail: "y" }]).subagent).toBeUndefined();
    expect(seq([{ type: "subagent-status", phase: "done", agent: "X", detail: "1s" }]).subagent).toBeUndefined();
  });

  it("folds the block (agent + duration, no steps) into the assistant message on turn-end", () => {
    const s = seq([
      { type: "subagent-status", phase: "start", agent: "Code Analyser" },
      { type: "subagent-status", phase: "done", agent: "Code Analyser", detail: "5s" },
      { type: "delta", text: "Report: ..." },
      { type: "turn-end" }
    ]);
    expect(s.subagent).toBeUndefined();
    const last = s.messages.at(-1)!;
    expect(last.role).toBe("assistant");
    expect(last.text).toBe("Report: ...");
    expect(last.activity).toEqual({ agent: "Code Analyser", duration: "5s", error: undefined });
  });

  it("creates an activity-only assistant message when the turn ends with no text", () => {
    const s = seq([
      { type: "subagent-status", phase: "start", agent: "Code Analyser" },
      { type: "turn-end" }
    ]);
    expect(s.messages.at(-1)).toMatchObject({ role: "assistant", text: "" });
    expect(s.messages.at(-1)!.activity).toMatchObject({ agent: "Code Analyser" });
  });

  it("clears the live block on turn-error but keeps it in the transcript", () => {
    const s = seq([
      { type: "subagent-status", phase: "start", agent: "Code Analyser" },
      { type: "subagent-status", phase: "error", agent: "Code Analyser", detail: "boom" },
      { type: "turn-error", message: "turn failed", isAuthError: false }
    ]);
    expect(s.subagent).toBeUndefined();
    expect(s.messages.at(-1)!.activity).toMatchObject({ error: "boom" });
    expect(s.error?.message).toBe("turn failed");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/web/tests/state.test.ts`
Expected: FAIL — `subagent` still carries `steps`; `duration` not set.

- [ ] **Step 3: Implement in `packages/web/client/src/state.ts`**

1. `SubAgentActivity` (lines 4-8):

```ts
export interface SubAgentActivity {
  agent: string;
  error?: string;
  /** Wall-clock duration string (e.g. "34s") once the sub-agent finished. */
  duration?: string;
}
```

2. `ChatMessage.activity` doc comment (line 14): change to
`/** Sub-agent run that happened during this turn (folded in at turn end). */`

3. `foldActivity` (lines 59-61) — fold agent + error + duration, no steps:

```ts
  const activity = s.subagent
    ? { agent: s.subagent.agent, error: s.subagent.error, duration: s.subagent.duration }
    : undefined;
```

4. `subagent-status` reducer (lines 148-173):

```ts
    case "subagent-status":
      switch (e.phase) {
        case "start":
          return { ...s, subagent: { agent: e.agent, done: false } };
        case "tool":
          return s; // steps are intentionally not surfaced
        case "done":
          return s.subagent
            ? { ...s, subagent: { ...s.subagent, done: true, duration: e.detail } }
            : s;
        case "error":
          return s.subagent
            ? { ...s, subagent: { ...s.subagent, error: e.detail, done: true } }
            : s;
        default:
          return s;
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/web/tests/state.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint and commit**

```bash
npx eslint packages/web/client/src/state.ts packages/web/tests/state.test.ts
git add packages/web/client/src/state.ts packages/web/tests/state.test.ts
git commit -m "feat(web): quiet sub-agent status (drop per-tool steps)"
```

---

### Task 2: Web view — one-line `ActivityBlock`

**Files:**
- Modify: `packages/web/client/src/views/Chat.tsx` (`ActivityBlock` lines 54-73; live-block render line 162; folded render line 153; autoscroll dep line 136)

**Interfaces:**
- Consumes: `SubAgentActivity & { duration?; done? }` from state (Task 1). `ActivityBlock` props become `{ agent: string; error?: string; duration?: string; running?: boolean }`.

- [ ] **Step 1: Implement the one-line block**

Replace `ActivityBlock` (lines 54-73) in `packages/web/client/src/views/Chat.tsx`:

```tsx
function ActivityBlock({
  agent,
  error,
  duration,
  running
}: {
  agent: string;
  error?: string;
  duration?: string;
  running?: boolean;
}) {
  const status = error
    ? `failed: ${error}`
    : running
      ? "is analysing the code…"
      : `— report ready${duration ? ` (${duration})` : ""}`;
  return (
    <div
      className={`rounded px-4 py-2 bg-surface-container text-label-md ${
        error ? "text-error" : "text-on-surface-variant"
      }`}
      role="status"
      aria-live="polite"
    >
      🔬 {agent} {status}
    </div>
  );
}
```

- [ ] **Step 2: Wire the live and folded renders**

Folded (inside the assistant-message map, currently line 153
`{m.activity && <ActivityBlock {...m.activity} />}`): unchanged call is fine —
`m.activity` now carries `{ agent, error?, duration? }` and `running` is
absent (falsy), so it renders the "report ready" / "failed" form. Leave line
153 as `{m.activity && <ActivityBlock {...m.activity} />}`.

Live block (currently line 162 `{state.subagent && <ActivityBlock {...state.subagent} />}`): pass `running` while not done:

```tsx
            {state.subagent && (
              <ActivityBlock
                agent={state.subagent.agent}
                error={state.subagent.error}
                duration={state.subagent.duration}
                running={!state.subagent.done}
              />
            )}
```

Autoscroll dep (line 136) — `steps` is gone; key on the block's presence and done-state:

```tsx
  }, [state.messages.length, state.streaming, state.busy, state.subagent?.done]);
```

- [ ] **Step 3: Verify build + web suite + typecheck**

Run: `npx vitest run packages/web/tests/ && npm run typecheck`
Expected: PASS / clean (no view test; Task 1's reducer tests cover behavior, typecheck confirms prop wiring).

- [ ] **Step 4: Lint and commit**

```bash
npx eslint packages/web/client/src/views/Chat.tsx
git add packages/web/client/src/views/Chat.tsx
git commit -m "feat(web): one-line Code Analyser status in chat"
```

---

### Task 3: CLI — ignore `tool` phase, labeled start line

**Files:**
- Modify: `packages/sre-agent/src/cli/index.ts` (`onSubAgent` handler, lines 206-216)

**Interfaces:**
- Consumes: `SubAgentEvent` (`{ phase; agent; detail? }`) via `onSubAgent`.

- [ ] **Step 1: Implement**

Replace the `onSubAgent` handler (lines 206-216) in `packages/sre-agent/src/cli/index.ts`:

```tsx
    onSubAgent: (e) => {
      if (e.phase === "tool") return; // per-tool steps are intentionally not printed
      const line =
        e.phase === "start"
          ? "is analysing the code…"
          : e.phase === "done"
            ? `: report ready (${e.detail ?? ""})`
            : `: failed: ${e.detail ?? ""}`;
      stdout.write(`\n  🔬 ${e.agent} ${line}\n`);
    }
```

(Start renders `🔬 Code Analyser is analysing the code…`; done/error keep the
`:`-prefixed form via the `line` string.)

- [ ] **Step 2: Typecheck + lint**

Run: `npm run typecheck && npx eslint packages/sre-agent/src/cli/index.ts`
Expected: clean. (CLI has no unit test by existing convention; the change is a
presentation branch.)

- [ ] **Step 3: Commit**

```bash
git add packages/sre-agent/src/cli/index.ts
git commit -m "feat(sre-agent): quiet Code Analyser CLI output (labeled start, no per-tool lines)"
```

---

### Task 4: Full verification

**Files:** none new — whole-workspace gates.

- [ ] **Step 1: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: clean exit (includes Vite client build).

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: all packages green (engine sub-agent tests untouched and still passing).

- [ ] **Step 3: Lint + format**

Run: `npm run lint && npm run format:check`
Expected: lint 0 errors (pre-existing warnings tolerated). If format:check fails on changed files, `npm run format`, re-run all gates.

- [ ] **Step 4: Commit fixups only if any exist**

```bash
git add -A
git commit -m "chore: verification fixups for quiet sub-agent progress"
```
