# Sub-Agent Activity Visibility — Design

**Date:** 2026-07-07
**Status:** Approved

## Problem

During incident code analysis the user hands over a repo URL and then sees
nothing until the final report. There is no signal that a specialized Code
Analyser sub-agent exists or that work (clone, search, read) is progressing.

Two concrete gaps found in the current code:

1. **The web chat has no `analyze_code` at all.** Task 6 wired the tool only
   in the CLI (`packages/sre-agent/src/cli/index.ts`); the web server builds
   its toolset with plain `buildTools(runtime)`
   (`packages/web/server/index.ts:57`), so in the web UI the main model falls
   back to calling the raw repo tools itself — no sub-agent.
2. **Progress display is transient and unlabeled.** The web client shows a
   single `Running <tool>…` line that each `tool-start` event overwrites and
   the first delta erases (`Chat.tsx:151`, `state.ts:112`). The CLI prints
   `↳ tool…` lines, but sub-agent tool starts are forwarded through the same
   `onToolStart` as main-agent tools (engine.ts, Task 5), so nothing marks
   them as sub-agent activity.

## Decision (user-confirmed)

Both surfaces get a **labeled step timeline**: persistent lines in the
transcript — "Code Analyser started" → one line per tool step → "report
ready"/error. No streaming of the sub-agent's narration text (rejected as
noisy; defeats the keep-code-out-of-main-chat design). No spinner-only
variant (leaves no trace after the turn).

## Architecture

### 1. Engine: `SubAgentEvent` + `onSubAgent` callback

`packages/sre-agent/src/engine/engine.ts`:

```ts
export interface SubAgentEvent {
  phase: "start" | "tool" | "done" | "error";
  /** Human label of the sub-agent, e.g. "Code Analyser". */
  agent: string;
  /** Phase-specific detail: tool name + short arg summary, duration, or error message. */
  detail?: string;
}
```

- `EngineDeps` gains optional `onSubAgent?: (e: SubAgentEvent) => void`
  (no-op when absent — both fronts opt in independently).
- `runSubAgent(opts: { tools; prompt; agentLabel?: string })` (default label
  `"sub-agent"`):
  - emits `{ phase: "start" }` before creating the session,
  - on each sub-session `tool.execution_start` emits `{ phase: "tool",
    detail: "<toolName>" or "<toolName> — <arg summary>" }` where the arg
    summary is the tool's most informative argument (`pattern` for
    search_repo, `path` for read_repo_file/repo_history, `ref` for
    checkout_repo when present), single-line, truncated to ~60 chars.
    `repo_url` is never echoed (noise; the user just typed it),
  - **no longer forwards sub-agent tool starts to `deps.onToolStart`** —
    that channel is main-session activity only (resolves the carried T5
    note about mislabeled `↳` lines),
  - on success emits `{ phase: "done", detail: "<n>s" }` (duration from a
    monotonic start mark),
  - on failure emits `{ phase: "error", detail: message }` before
    rethrowing (messages from GitRepoClient are already PAT-redacted).
- `analyze_code` (`packages/sre-agent/src/tools/analyzeCode.ts`) passes
  `agentLabel: "Code Analyser"`.

### 2. CLI

`packages/sre-agent/src/cli/index.ts` — wire `onSubAgent` next to
`onToolStart`, printing persistent lines in the existing style:

```
  🔬 Code Analyser: started
  🔬 Code Analyser: checkout_repo
  🔬 Code Analyser: search_repo — "PaymentError"
  🔬 Code Analyser: report ready (34s)
```

(`start` → "started", `tool` → detail, `done` → `report ready (<detail>)`,
`error` → `failed: <detail>`.)

### 3. Web server

- `packages/web/shared/events.ts`: add
  `{ type: "subagent-status"; phase: "start" | "tool" | "done" | "error"; agent: string; detail?: string }`
  to `ServerEvent`.
- `packages/web/server/engine-host.ts`:
  - `buildEngine` wires `onSubAgent: (e) => emit({ type: "subagent-status", ...e })`.
  - New seam `EngineHostOptions.extraToolsFactory?: (getEngine: () => ChatEngine) => Tool<unknown>[]`.
    `buildEngine` appends `extraToolsFactory(() => engine)` to `opts.tools`.
    The closure reads the host's mutable `engine` variable, so the lazy ref
    stays correct across `restart()` rebuilds (same construction-cycle break
    as the CLI's `engineRef`).
- `packages/web/server/index.ts`: pass
  `extraToolsFactory: (getEngine) => [buildAnalyzeCodeTool(runtime, getEngine)]`
  — the web chat gains the real Code Analyser sub-agent.

### 4. Web client

- `packages/web/client/src/state.ts`: state gains
  `subagent?: { agent: string; steps: string[]; error?: string; done: boolean }`.
  Reducer:
  - `subagent-status` `start` → fresh block `{ agent, steps: ["started"], done: false }`,
  - `tool` → append `detail` to `steps`,
  - `done` → append `report ready (<detail>)`, mark `done`,
  - `error` → set `error`, mark `done`,
  - `turn-end` / `turn-error` → fold the block into the completed assistant
    message (persistent transcript trace) and clear the live block.
- `packages/web/client/src/views/Chat.tsx`: render the live block (and folded
  blocks inside past messages) as a compact activity list — small monospace
  lines with the agent label — visually distinct from message text. The
  existing `Running <tool>…` spinner line stays for main-agent tools.

### 5. Data flow

```
analyze_code → runSubAgent(agentLabel: "Code Analyser")
  ├─ onSubAgent {start}                        → CLI line / SSE subagent-status → UI block appears
  ├─ sub-session tool.execution_start ×N       → {tool, "search_repo — \"PaymentError\""} → lines append
  ├─ success: {done, "34s"}                    → "report ready (34s)"
  └─ failure: {error, msg} + rethrow           → "failed: <msg>" (analyze_code still returns { error })
```

## Error handling

- `onSubAgent` optional everywhere; absence = silent (MCP surface and tests
  unaffected).
- `error` phase fires before the rethrow that `analyze_code` converts to
  `{ error }` — UI shows the failure line even though the turn continues.
- Detail strings are single-line, truncated; PAT redaction already handled
  upstream (GitRepoClient) — no new secret paths.

## Testing

- **Engine** (`packages/sre-agent/tests/engine.test.ts`, existing fake-client
  seam): runSubAgent emits start/tool/done in order with the label; tool
  detail includes the summarized arg; error path emits `error` and rethrows;
  `onToolStart` no longer receives sub-agent tool starts (update the Task-5
  assertion); absent `onSubAgent` → no throw.
- **analyzeCode** (`tests/analyze-code.test.ts`): `runSubAgent` called with
  `agentLabel: "Code Analyser"`.
- **Engine host** (`packages/web/tests`, existing `emit` capture seam):
  `onSubAgent` mapped to `subagent-status` events; `extraToolsFactory` tools
  appended and `getEngine` resolves the current engine after `restart()`.
- **Client reducer** (`packages/web/tests`): subagent-status sequence builds
  the block; turn-end folds it into the message.

## Out of scope (deliberate)

- Streaming sub-agent narration/deltas to any surface.
- Per-step durations/timestamps (final duration only).
- Collapsible/expandable UI, persistence across page reloads.
- MCP surface changes (host UIs own their own progress display).
