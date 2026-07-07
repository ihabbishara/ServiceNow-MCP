# Sub-Agent Activity Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a labeled, persistent step timeline of Code Analyser sub-agent activity in both the CLI and web chat, and give the web chat the `analyze_code` sub-agent it currently lacks.

**Architecture:** `ChatEngine.runSubAgent` gains a dedicated `onSubAgent` progress callback (phases start/tool/done/error, labeled per sub-agent) and stops leaking sub-agent tool starts through the main `onToolStart`. The CLI prints prefixed lines; the web server maps the callback to a new `subagent-status` SSE event and gains an `extraToolsFactory` seam so `analyze_code` can be wired with a lazy engine ref; the web client accumulates steps into an activity block that folds into the transcript at turn end.

**Tech Stack:** TypeScript ESM monorepo, vitest, `@github/copilot-sdk` session events, React (web client), SSE.

**Spec:** `docs/superpowers/specs/2026-07-07-subagent-visibility-design.md`

## Global Constraints

- `onSubAgent` is optional everywhere; when absent, nothing is emitted and nothing throws (MCP surface and existing tests unaffected).
- `SubAgentEvent = { phase: "start" | "tool" | "done" | "error"; agent: string; detail?: string }` — exact shape shared by engine, SSE event, and client.
- Sub-agent tool starts must NOT reach `deps.onToolStart` anymore (main-session channel only).
- Tool detail: `"<toolName>"` or `"<toolName> — \"<arg>\""` where arg is the first present of `pattern`, `path`, `ref` (string, non-empty), newlines stripped, truncated to 60 chars with `…`. `repo_url` is never echoed.
- `analyze_code` passes `agentLabel: "Code Analyser"`; `runSubAgent` defaults the label to `"sub-agent"`.
- `error` phase fires before the rethrow; error messages are already PAT-redacted upstream — no new formatting of git output.
- Run all commands from repo root `/Users/ihabbishara/projects/ServiceNowMCP`.
- Lint-clean before commit: `npx eslint <changed files>`.

---

### Task 1: Engine — `SubAgentEvent` + `onSubAgent` emissions

**Files:**
- Modify: `packages/sre-agent/src/engine/engine.ts` (EngineDeps ~line 90, runSubAgent lines 212-245)
- Test: `packages/sre-agent/tests/engine.test.ts`

**Interfaces:**
- Consumes: existing `runSubAgent`, fake client/session seams in engine.test.ts (`makeFakeSession(deltas)`, `makeFakeClient(authStatus?, subAgentDeltas?)`, per-createSession sessions array).
- Produces (Tasks 2-3 rely on):
  - `export interface SubAgentEvent { phase: "start" | "tool" | "done" | "error"; agent: string; detail?: string }`
  - `EngineDeps.onSubAgent?: (e: SubAgentEvent) => void`
  - `runSubAgent(opts: { tools: Tool<any>[]; prompt: string; agentLabel?: string }): Promise<string>`

- [ ] **Step 1: Extend the fakes and write the failing tests**

In `packages/sre-agent/tests/engine.test.ts`:

1. Extend `makeFakeSession` so sub-agent sessions can fire tool events before deltas, and keep the deterministic reject path added in the previous feature (adapt to the file's current shape — the parameters below are additive):

```ts
const makeFakeSession = (
  deltas: string[] = [],
  opts: { toolEvents?: { toolName: string; arguments?: Record<string, unknown> }[]; rejectWith?: Error } = {}
) => {
  const handlers: Record<string, (e: { data: any }) => void> = {};
  const session = {
    on: vi.fn((event: string, cb: (e: { data: any }) => void) => {
      handlers[event] = cb;
      return vi.fn();
    }),
    sendAndWait: vi.fn(async () => {
      for (const t of opts.toolEvents ?? []) {
        handlers["tool.execution_start"]?.({ data: { toolName: t.toolName, arguments: t.arguments } });
      }
      if (opts.rejectWith) throw opts.rejectWith;
      for (const d of deltas) handlers["assistant.message_delta"]?.({ data: { deltaContent: d } });
      return undefined;
    }),
    disconnect: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined)
  };
  return session;
};
```

2. Thread the new options through `makeFakeClient` (sub-agent sessions — index >= 1 — get `subAgentDeltas` plus a new `subAgentOpts` parameter):

```ts
const makeFakeClient = (
  authStatus = { isAuthenticated: true, login: "octocat", authType: "user" as const },
  subAgentDeltas: string[] = [],
  subAgentOpts: { toolEvents?: { toolName: string; arguments?: Record<string, unknown> }[]; rejectWith?: Error } = {}
) => {
  const sessions: ReturnType<typeof makeFakeSession>[] = [];
  const createSession = vi.fn(async (_config: SessionConfig) => {
    const s = sessions.length === 0 ? makeFakeSession() : makeFakeSession(subAgentDeltas, subAgentOpts);
    sessions.push(s);
    return s;
  });
  const getAuthStatus = vi.fn(async () => authStatus);
  const client = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => [] as Error[]),
    getAuthStatus,
    createSession
  };
  return { client, createSession, getAuthStatus, sessions };
};
```

Update any existing tests broken by the signature change mechanically (e.g. the previous deterministic-reject test now passes `rejectWith` via `subAgentOpts`).

3. Add the new describe:

```ts
describe("runSubAgent onSubAgent events", () => {
  const run = async (opts: {
    deltas?: string[];
    toolEvents?: { toolName: string; arguments?: Record<string, unknown> }[];
    rejectWith?: Error;
    agentLabel?: string;
  }) => {
    const { client } = makeFakeClient(undefined, opts.deltas ?? ["ok"], {
      toolEvents: opts.toolEvents,
      rejectWith: opts.rejectWith
    });
    const config = loadAgentConfig({ ...base });
    const events: import("../src/engine/engine.js").SubAgentEvent[] = [];
    const onToolStart = vi.fn();
    const engine = new ChatEngine({
      config,
      tools: [],
      ...noopDeps,
      onToolStart,
      onSubAgent: (e) => events.push(e),
      clientFactory: () => client as never
    });
    await engine.start();
    const result = engine.runSubAgent({
      tools: [],
      prompt: "x",
      ...(opts.agentLabel ? { agentLabel: opts.agentLabel } : {})
    });
    return { result, events, onToolStart };
  };

  it("emits start → tool (with arg summary) → done, labeled", async () => {
    const { result, events } = await run({
      agentLabel: "Code Analyser",
      toolEvents: [
        { toolName: "checkout_repo", arguments: { repo_url: "https://dev.azure.com/o/p/_git/r" } },
        { toolName: "search_repo", arguments: { pattern: "PaymentError", repo_url: "https://x" } }
      ]
    });
    await result;
    expect(events.map((e) => e.phase)).toEqual(["start", "tool", "tool", "done"]);
    expect(events.every((e) => e.agent === "Code Analyser")).toBe(true);
    expect(events[1].detail).toBe("checkout_repo"); // repo_url never echoed
    expect(events[2].detail).toBe('search_repo — "PaymentError"');
    expect(events[3].detail).toMatch(/^\d+s$/);
  });

  it("defaults the label to 'sub-agent'", async () => {
    const { result, events } = await run({});
    await result;
    expect(events[0]).toMatchObject({ phase: "start", agent: "sub-agent" });
  });

  it("truncates long args to 60 chars and strips newlines", async () => {
    const long = "a".repeat(80) + "\nsecond line";
    const { result, events } = await run({ toolEvents: [{ toolName: "search_repo", arguments: { pattern: long } }] });
    await result;
    const detail = events[1].detail!;
    expect(detail).toContain("search_repo — ");
    expect(detail).not.toContain("\n");
    expect(detail.length).toBeLessThanOrEqual("search_repo — ".length + 64);
    expect(detail).toContain("…");
  });

  it("emits error (then rethrows) when the sub-agent fails", async () => {
    const { result, events } = await run({ rejectWith: new Error("timeout waiting for session.idle") });
    await expect(result).rejects.toThrow(/timeout/);
    expect(events.map((e) => e.phase)).toEqual(["start", "error"]);
    expect(events.at(-1)).toMatchObject({ phase: "error", detail: expect.stringContaining("timeout") });
  });

  it("does NOT forward sub-agent tool starts to onToolStart", async () => {
    const { result, onToolStart } = await run({ toolEvents: [{ toolName: "search_repo" }] });
    await result;
    expect(onToolStart).not.toHaveBeenCalled();
  });

  it("is silent and safe when onSubAgent is not provided", async () => {
    const { client } = makeFakeClient(undefined, ["ok"], { toolEvents: [{ toolName: "search_repo" }] });
    const config = loadAgentConfig({ ...base });
    const engine = new ChatEngine({ config, tools: [], ...noopDeps, clientFactory: () => client as never });
    await engine.start();
    await expect(engine.runSubAgent({ tools: [], prompt: "x" })).resolves.toBe("ok");
  });
});
```

Also update the existing Task-5-era test that asserted sub-agent `tool.execution_start` reaches `onToolStart` (if present) — that behavior is now inverted.

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run packages/sre-agent/tests/engine.test.ts`
Expected: new describe FAILS (`onSubAgent` unknown / events empty / detail undefined); pre-existing tests PASS after the mechanical fake updates. Fix fake fallout first.

- [ ] **Step 3: Implement in `packages/sre-agent/src/engine/engine.ts`**

1. Add the event type and deps field:

```ts
/** Progress event from a runSubAgent invocation, for UI surfaces to display. */
export interface SubAgentEvent {
  phase: "start" | "tool" | "done" | "error";
  /** Human label of the sub-agent, e.g. "Code Analyser". */
  agent: string;
  /** Phase detail: tool name + short arg summary, duration ("34s"), or error message. */
  detail?: string;
}
```

In `EngineDeps` (next to `onToolStart`):

```ts
  /** Sub-agent progress (start/tool/done/error); optional — surfaces opt in. */
  onSubAgent?: (e: SubAgentEvent) => void;
```

2. Add the private detail helper (module-private, above the class):

```ts
// The most informative argument per repo tool; repo_url is never echoed (noise —
// the user supplied it) and values are flattened to one short line.
const DETAIL_ARG_KEYS = ["pattern", "path", "ref"] as const;
const toolDetail = (name: string, args?: Record<string, unknown>): string => {
  for (const key of DETAIL_ARG_KEYS) {
    const v = args?.[key];
    if (typeof v === "string" && v) {
      const flat = v.replace(/\s+/g, " ").trim();
      const short = flat.length > 60 ? `${flat.slice(0, 59)}…` : flat;
      return `${name} — "${short}"`;
    }
  }
  return name;
};
```

3. Replace `runSubAgent` (current lines 212-245) with:

```ts
  /**
   * Run a one-shot sub-agent: a second session on the same client with a
   * restricted toolset. Deltas are not streamed to the UI; they accumulate and
   * the final text returns. Progress is reported through `deps.onSubAgent`
   * (start → tool per execution → done/error) labeled with `agentLabel`;
   * sub-agent tool starts do NOT reach `deps.onToolStart` — that channel is
   * main-session activity only. The sub-session is disconnected afterwards;
   * the main session is untouched.
   */
  async runSubAgent(opts: {
    tools: Tool<any>[];
    prompt: string;
    agentLabel?: string;
  }): Promise<string> {
    if (!this.client) throw new Error("engine not started");
    const cfg = this.deps.config;
    const agent = opts.agentLabel ?? "sub-agent";
    const emit = (phase: SubAgentEvent["phase"], detail?: string) =>
      this.deps.onSubAgent?.({ phase, agent, ...(detail !== undefined ? { detail } : {}) });
    const startedAt = Date.now();
    emit("start");
    try {
      const session = await this.client.createSession({
        model: cfg.llm.model,
        streaming: true,
        tools: opts.tools,
        // Sub-agent toolset is read-only; deny anything that asks for permission.
        onPermissionRequest: async () => ({
          kind: "reject" as const,
          feedback: "Sub-agent tools are read-only."
        }),
        ...this.providerConfig()
      });
      const chunks: string[] = [];
      const offDelta = session.on("assistant.message_delta", (e) =>
        chunks.push(e.data.deltaContent)
      );
      const offTool = session.on("tool.execution_start", (e) =>
        emit("tool", toolDetail(e.data.toolName, e.data.arguments))
      );
      try {
        await session.sendAndWait(opts.prompt, cfg.turnTimeoutMs);
      } finally {
        offDelta();
        offTool();
        await session.disconnect().catch(() => undefined);
      }
      emit("done", `${Math.round((Date.now() - startedAt) / 1000)}s`);
      return chunks.join("");
    } catch (err) {
      emit("error", err instanceof Error ? err.message : String(err));
      throw err;
    }
  }
```

(Note the `tool.execution_start` handler no longer touches `this.deps.onToolStart`; `e.data.arguments` is typed by the SDK as `{ [k: string]: unknown | undefined } | undefined`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/sre-agent/tests/engine.test.ts`
Expected: PASS — all pre-existing + new.

- [ ] **Step 5: Lint and commit**

```bash
npx eslint packages/sre-agent/src/engine/engine.ts packages/sre-agent/tests/engine.test.ts
git add packages/sre-agent/src/engine/engine.ts packages/sre-agent/tests/engine.test.ts
git commit -m "feat(sre-agent): SubAgentEvent progress callback on runSubAgent"
```

---

### Task 2: Label from `analyze_code`, CLI lines, barrel exports

**Files:**
- Modify: `packages/sre-agent/src/tools/analyzeCode.ts:44`
- Modify: `packages/sre-agent/src/cli/index.ts` (engine construction block, `onToolStart` line)
- Modify: `packages/sre-agent/src/index.ts`
- Test: `packages/sre-agent/tests/analyze-code.test.ts`, `packages/sre-agent/tests/exports.test.ts`

**Interfaces:**
- Consumes: `runSubAgent({ tools, prompt, agentLabel })` and `SubAgentEvent` (Task 1).
- Produces: `@sre/sre-agent` barrel exports `buildAnalyzeCodeTool` and type `SubAgentEvent` (Task 3 imports both in packages/web).

- [ ] **Step 1: Write the failing tests**

In `packages/sre-agent/tests/analyze-code.test.ts`, add to the existing describe (reusing its `makeEngine`/`call` helpers):

```ts
  it("labels the sub-agent 'Code Analyser'", async () => {
    const engine = makeEngine();
    const tool = buildAnalyzeCodeTool(runtime, () => engine);
    await call(tool, { repo_url: "u", error_text: "e" });
    const arg = (engine.runSubAgent as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.agentLabel).toBe("Code Analyser");
  });
```

In `packages/sre-agent/tests/exports.test.ts`, add `"buildAnalyzeCodeTool"` to the exported-function name list.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/sre-agent/tests/analyze-code.test.ts packages/sre-agent/tests/exports.test.ts`
Expected: FAIL — `agentLabel` undefined; `buildAnalyzeCodeTool` not exported from the barrel.

- [ ] **Step 3: Implement**

1. `packages/sre-agent/src/tools/analyzeCode.ts` line 44:

```ts
        const report = await getEngine().runSubAgent({
          tools,
          prompt,
          agentLabel: "Code Analyser"
        });
```

2. `packages/sre-agent/src/index.ts` — add:

```ts
export { buildAnalyzeCodeTool, CODE_ANALYSER_TOOL_NAMES } from "./tools/analyzeCode.js";
export type { SubAgentEvent } from "./engine/engine.js";
```

3. `packages/sre-agent/src/cli/index.ts` — in the `new ChatEngine({...})` deps (next to `onToolStart: (n) => stdout.write(...)`), add:

```ts
    onSubAgent: (e) => {
      const line =
        e.phase === "start"
          ? "started"
          : e.phase === "done"
            ? `report ready (${e.detail ?? ""})`
            : e.phase === "error"
              ? `failed: ${e.detail ?? ""}`
              : (e.detail ?? "");
      stdout.write(`\n  🔬 ${e.agent}: ${line}\n`);
    },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/sre-agent/tests/`
Expected: full sre-agent package PASS.

- [ ] **Step 5: Lint and commit**

```bash
npx eslint packages/sre-agent/src/tools/analyzeCode.ts packages/sre-agent/src/cli/index.ts packages/sre-agent/src/index.ts packages/sre-agent/tests/analyze-code.test.ts packages/sre-agent/tests/exports.test.ts
git add packages/sre-agent/src packages/sre-agent/tests/analyze-code.test.ts packages/sre-agent/tests/exports.test.ts
git commit -m "feat(sre-agent): Code Analyser label, CLI sub-agent lines, barrel exports"
```

---

### Task 3: Web server — `subagent-status` SSE + `extraToolsFactory` + `analyze_code` wiring

**Files:**
- Modify: `packages/web/shared/events.ts`
- Modify: `packages/web/server/engine-host.ts` (options ~line 30, `buildEngine` ~line 126)
- Modify: `packages/web/server/index.ts` (~lines 52-58)
- Test: `packages/web/tests/engine-host.test.ts`

**Interfaces:**
- Consumes: `SubAgentEvent`, `buildAnalyzeCodeTool` from `@sre/sre-agent` (Task 2); `EngineDeps.onSubAgent` (Task 1).
- Produces (Task 4 relies on): `ServerEvent` member
  `{ type: "subagent-status"; phase: "start" | "tool" | "done" | "error"; agent: string; detail?: string }`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/web/tests/engine-host.test.ts` (reusing its `FakeEngine` and `ServerEvent` imports; `makeHost` is not reused because these tests pass extra options):

```ts
describe("engine-host sub-agent visibility", () => {
  it("maps onSubAgent callbacks to subagent-status events", async () => {
    const events: ServerEvent[] = [];
    const host = createEngineHost({
      config: { llm: { mode: "seat", model: "gpt-5" } } as any,
      tools: [],
      engineFactory: (deps) => new FakeEngine(deps) as any,
      emit: (e) => events.push(e),
      idFactory: () => "fixed-id"
    });
    await host.start();
    FakeEngine.last.deps.onSubAgent({ phase: "tool", agent: "Code Analyser", detail: "search_repo" });
    expect(events).toContainEqual({
      type: "subagent-status",
      phase: "tool",
      agent: "Code Analyser",
      detail: "search_repo"
    });
  });

  it("appends extraToolsFactory tools and getEngine resolves the current engine", async () => {
    const events: ServerEvent[] = [];
    let capturedGetEngine: (() => unknown) | undefined;
    const marker = { name: "analyze_code" };
    const host = createEngineHost({
      config: { llm: { mode: "seat", model: "gpt-5" } } as any,
      tools: [{ name: "base_tool" } as any],
      extraToolsFactory: (getEngine) => {
        capturedGetEngine = getEngine;
        return [marker as any];
      },
      engineFactory: (deps) => new FakeEngine(deps) as any,
      emit: (e) => events.push(e),
      idFactory: () => "fixed-id"
    });
    await host.start();
    expect(FakeEngine.last.deps.tools.map((t: { name: string }) => t.name)).toEqual([
      "base_tool",
      "analyze_code"
    ]);
    expect(capturedGetEngine!()).toBe(FakeEngine.last);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/web/tests/engine-host.test.ts`
Expected: FAIL — `onSubAgent` not a function on deps; `extraToolsFactory` unknown option / tools not appended. (A TS error on the `subagent-status` literal until events.ts is updated is the same failure signal.)

- [ ] **Step 3: Implement**

1. `packages/web/shared/events.ts` — add to the `ServerEvent` union:

```ts
  | {
      type: "subagent-status";
      phase: "start" | "tool" | "done" | "error";
      agent: string;
      detail?: string;
    }
```

2. `packages/web/server/engine-host.ts`:

Add to `EngineHostOptions` (after `engineFactory`):

```ts
  /**
   * Extra Copilot tools that need a live engine reference (e.g. analyze_code,
   * whose handler spawns a sub-agent session). `getEngine` resolves the host's
   * CURRENT engine — correct across restart() rebuilds.
   */
  extraToolsFactory?: (getEngine: () => ChatEngine) => Tool<unknown>[];
```

Replace `buildEngine` (~line 126):

```ts
  const buildEngine = (cfg: AgentConfig) =>
    engineFactory({
      config: cfg,
      tools: [...opts.tools, ...(opts.extraToolsFactory?.(() => engine) ?? [])],
      confirm,
      onDelta: (text) => emit({ type: "delta", text }),
      onToolStart: (name) => emit({ type: "tool-start", name }),
      onSubAgent: (e) =>
        emit({ type: "subagent-status", phase: e.phase, agent: e.agent, detail: e.detail })
    });
```

(`engine` is the host's mutable `let engine = buildEngine(config)` binding — the arrow thunk reads it lazily at tool-call time, after assignment; same construction-cycle break as the CLI's `engineRef`. If `EngineDeps`'s `tools` type complains about `Tool<unknown>`, cast the array `as EngineDeps["tools"]`.)

3. `packages/web/server/index.ts` — extend the dynamic import (line 52) with `buildAnalyzeCodeTool` and wire the factory (line 58):

```ts
      const { loadAgentConfig, loadDotenv, buildTools, bootCrawl, buildAnalyzeCodeTool } =
        await import("@sre/sre-agent");
```

```ts
      const h = createEngineHost({
        config,
        tools,
        extraToolsFactory: (getEngine) => [
          buildAnalyzeCodeTool(runtime, getEngine) as import("@github/copilot-sdk").Tool<unknown>
        ],
        runtimeFactory: () => runtime
      });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/web/tests/`
Expected: full web package PASS (host lifecycle/routes/boot tests unaffected — new option and callback are optional).

- [ ] **Step 5: Lint and commit**

```bash
npx eslint packages/web/shared/events.ts packages/web/server/engine-host.ts packages/web/server/index.ts packages/web/tests/engine-host.test.ts
git add packages/web/shared/events.ts packages/web/server/engine-host.ts packages/web/server/index.ts packages/web/tests/engine-host.test.ts
git commit -m "feat(web): subagent-status SSE + extraToolsFactory wiring analyze_code"
```

---

### Task 4: Web client — activity block in state and Chat view

**Files:**
- Modify: `packages/web/client/src/state.ts`
- Modify: `packages/web/client/src/views/Chat.tsx`
- Test: `packages/web/tests/state.test.ts`

**Interfaces:**
- Consumes: `subagent-status` ServerEvent (Task 3).
- Produces: `ChatMessage.activity?: { agent: string; steps: string[]; error?: string }`; `ChatState.subagent?: { agent: string; steps: string[]; error?: string; done: boolean }`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/web/tests/state.test.ts` (match its existing import style for `applyServerEvent`/`initialState`):

```ts
describe("subagent activity block", () => {
  const seq = (events: Parameters<typeof applyServerEvent>[1][]) =>
    events.reduce(applyServerEvent, initialState);

  it("builds the live block from start/tool/done", () => {
    const s = seq([
      { type: "subagent-status", phase: "start", agent: "Code Analyser" },
      { type: "subagent-status", phase: "tool", agent: "Code Analyser", detail: 'search_repo — "PaymentError"' },
      { type: "subagent-status", phase: "done", agent: "Code Analyser", detail: "34s" }
    ]);
    expect(s.subagent).toEqual({
      agent: "Code Analyser",
      steps: ["started", 'search_repo — "PaymentError"', "report ready (34s)"],
      done: true
    });
  });

  it("records error phase", () => {
    const s = seq([
      { type: "subagent-status", phase: "start", agent: "Code Analyser" },
      { type: "subagent-status", phase: "error", agent: "Code Analyser", detail: "clone failed" }
    ]);
    expect(s.subagent).toMatchObject({ error: "clone failed", done: true });
  });

  it("ignores tool/done/error without a preceding start", () => {
    const s = seq([{ type: "subagent-status", phase: "tool", agent: "X", detail: "y" }]);
    expect(s.subagent).toBeUndefined();
  });

  it("folds the block into the assistant message on turn-end", () => {
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
    expect(last.activity).toEqual({
      agent: "Code Analyser",
      steps: ["started", "report ready (5s)"],
      error: undefined
    });
  });

  it("creates an activity-only assistant message when the turn ends with no text", () => {
    const s = seq([
      { type: "subagent-status", phase: "start", agent: "Code Analyser" },
      { type: "turn-end" }
    ]);
    expect(s.messages.at(-1)).toMatchObject({ role: "assistant", text: "" });
    expect(s.messages.at(-1)!.activity?.steps).toEqual(["started"]);
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
Expected: new describe FAILS (`subagent` undefined on state / TS error on `activity`).

- [ ] **Step 3: Implement**

1. `packages/web/client/src/state.ts`:

Types:

```ts
export interface SubAgentActivity {
  agent: string;
  steps: string[];
  error?: string;
}

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  text: string;
  /** Sub-agent step timeline that ran during this turn (folded in at turn end). */
  activity?: SubAgentActivity;
}
```

`ChatState` gains:

```ts
  subagent?: SubAgentActivity & { done: boolean };
```

Add a fold helper above `applyServerEvent`:

```ts
// Fold the live sub-agent block (if any) into a transcript message so the
// timeline survives the end of the turn.
const foldActivity = (
  s: ChatState,
  streamingText: string
): Pick<ChatState, "messages" | "nextMessageId" | "subagent"> => {
  const activity = s.subagent
    ? { agent: s.subagent.agent, steps: s.subagent.steps, error: s.subagent.error }
    : undefined;
  const hasMsg = !!streamingText || !!activity;
  return {
    subagent: undefined,
    messages: hasMsg
      ? [
          ...s.messages,
          {
            id: s.nextMessageId,
            role: "assistant" as const,
            text: streamingText,
            ...(activity ? { activity } : {})
          }
        ]
      : s.messages,
    nextMessageId: hasMsg ? s.nextMessageId + 1 : s.nextMessageId
  };
};
```

Replace the `turn-end` case:

```ts
    case "turn-end":
      return {
        ...s,
        busy: false,
        activeTool: undefined,
        streaming: "",
        ...foldActivity(s, s.streaming)
      };
```

Replace the `turn-error` case:

```ts
    case "turn-error":
      return {
        ...s,
        busy: false,
        activeTool: undefined,
        streaming: "",
        error: { message: e.message, isAuthError: e.isAuthError },
        ...foldActivity(s, "")
      };
```

(Note `turn-error` folds with empty text — the partial stream is discarded today and stays discarded; only the activity survives.)

Add the `subagent-status` case (before `default`):

```ts
    case "subagent-status":
      switch (e.phase) {
        case "start":
          return { ...s, subagent: { agent: e.agent, steps: ["started"], done: false } };
        case "tool":
          return s.subagent
            ? { ...s, subagent: { ...s.subagent, steps: [...s.subagent.steps, e.detail ?? ""] } }
            : s;
        case "done":
          return s.subagent
            ? {
                ...s,
                subagent: {
                  ...s.subagent,
                  steps: [...s.subagent.steps, `report ready (${e.detail ?? ""})`],
                  done: true
                }
              }
            : s;
        case "error":
          return s.subagent
            ? { ...s, subagent: { ...s.subagent, error: e.detail, done: true } }
            : s;
        default:
          return s;
      }
```

2. `packages/web/client/src/views/Chat.tsx`:

Add a compact block component (top level of the file, near `Welcome`):

```tsx
function ActivityBlock({ agent, steps, error }: { agent: string; steps: string[]; error?: string }) {
  return (
    <div className="rounded px-4 py-2 bg-surface-container text-label-md text-on-surface-variant space-y-0.5">
      <div className="font-medium">🔬 {agent}</div>
      {steps.map((step, i) => (
        <div key={i} className="font-mono">
          · {step}
        </div>
      ))}
      {error && <div className="text-error font-mono">failed: {error}</div>}
    </div>
  );
}
```

Render folded blocks inside the assistant-message branch of `state.messages.map` (activity above the text):

```tsx
              ) : (
                <div key={m.id} className="space-y-2">
                  {m.activity && <ActivityBlock {...m.activity} />}
                  {m.text && (
                    <div className="rounded px-4 py-2 bg-surface-container">
                      <Markdown>{m.text}</Markdown>
                    </div>
                  )}
                </div>
              )
```

Render the live block between the messages list and the streaming block:

```tsx
            {state.subagent && <ActivityBlock {...state.subagent} />}
```

Extend the autoscroll effect deps so new steps pin to bottom:

```tsx
  }, [state.messages.length, state.streaming, state.busy, state.subagent?.steps.length]);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/web/tests/`
Expected: PASS.

- [ ] **Step 5: Lint and commit**

```bash
npx eslint packages/web/client/src/state.ts packages/web/client/src/views/Chat.tsx packages/web/tests/state.test.ts
git add packages/web/client/src/state.ts packages/web/client/src/views/Chat.tsx packages/web/tests/state.test.ts
git commit -m "feat(web): sub-agent activity block in chat transcript"
```

---

### Task 5: Full verification

**Files:** none new — whole-workspace gates.

- [ ] **Step 1: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: clean exit.

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: all packages green.

- [ ] **Step 3: Lint + format**

Run: `npm run lint && npm run format:check`
Expected: lint clean (pre-existing warnings tolerated; 0 errors). If format:check fails on changed files, run `npm run format`, re-run all three gates.

- [ ] **Step 4: Commit fixups only if any exist**

```bash
git add -A
git commit -m "chore: verification fixups for sub-agent visibility"
```
