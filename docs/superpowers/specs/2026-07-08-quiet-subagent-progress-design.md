# Quiet Code Analyser Progress — Design

**Date:** 2026-07-08
**Status:** Approved

## Problem

The Code Analyser sub-agent prints a step per tool call (`checkout_repo`,
`search_repo — "…"`, `read_repo_file`, …) on both CLI and web. It is too
noisy. What the user actually wants surfaced is one thing: **the Code Analyser
sub-agent took over and is analysing the code** — its identity and that it is
working, not each internal step.

## Decision (user-confirmed)

- Presentation only: a single labeled waiting indicator while the sub-agent
  runs (identity preserved), and one folded line in the transcript when it
  finishes. The per-tool step list is dropped.
- The **sub-agent identity is the point** — the indicator names "Code
  Analyser", it is never a generic "Thinking…".
- The engine is untouched: `runSubAgent` keeps emitting `start`/`tool`/`done`/
  `error` (the `SubAgentEvent` contract and its tests stand). Only the two
  presentation consumers change — they ignore `tool`. This keeps the change
  minimal and leaves the event stream available if a verbose mode is ever
  wanted.

## Architecture

### 1. CLI — `packages/sre-agent/src/cli/index.ts` (`onSubAgent`)

Drop the `tool` phase from output; keep start/done/error as single lines:

```
🔬 Code Analyser is analysing the code…
🔬 Code Analyser: report ready (34s)
```

- `start` → `🔬 <agent> is analysing the code…`
- `tool` → **no output** (return early)
- `done` → `🔬 <agent>: report ready (<detail>)`
- `error` → `🔬 <agent>: failed: <detail>`

### 2. Web state — `packages/web/client/src/state.ts`

`SubAgentActivity` loses `steps`; the live block becomes a status, not a
timeline:

```ts
export interface SubAgentActivity {
  agent: string;
  error?: string;
}
// live block:
subagent?: SubAgentActivity & { done: boolean; duration?: string };
```

Reducer `subagent-status`:
- `start` → `{ agent, done: false }`
- `tool` → **no-op** (`return s`)
- `done` → `{ ...s.subagent, done: true, duration: e.detail }`
- `error` → `{ ...s.subagent, error: e.detail, done: true }`

`foldActivity` folds `{ agent, error }` (plus duration in the message text)
into the assistant message exactly as today, minus `steps`.

### 3. Web view — `packages/web/client/src/views/Chat.tsx`

`ActivityBlock` renders a one-line status, not a step list:

- Running: `🔬 <agent> is analysing the code…` (with the existing waiting
  dots for motion).
- Done (folded in transcript): `🔬 <agent> — report ready (<duration>)`.
- Error: `🔬 <agent> — failed: <error>`.

The live block still renders between the messages list and the streaming
block; the folded one-liner still persists in the completed assistant message
(so the transcript records that the Code Analyser ran). Autoscroll dep
`state.subagent?.steps.length` becomes `state.subagent?.done` (steps is gone).

## Data flow

```
analyze_code → runSubAgent (emits start, tool×N, done)
  start → CLI: "🔬 Code Analyser is analysing the code…" / web: live labeled indicator
  tool  → ignored on both surfaces
  done  → CLI: "🔬 Code Analyser: report ready (34s)" / web: folds one line into transcript
```

## Error handling

Unchanged: `error` phase still surfaces a failed line (CLI) / failed status
(web); `analyze_code` still returns `{ error }` so the turn continues.

## Testing

- **Web state** (`packages/web/tests/state.test.ts`): rewrite the existing
  sub-agent block tests — `start` sets the labeled block, `tool` is a no-op
  (block unchanged), `done` sets `done` + `duration`, `error` sets error;
  `turn-end` folds `{ agent, error }` (no steps) into the message; the
  ignores-without-start guard stays.
- **CLI**: no unit test today (unchanged convention); the `tool` early-return
  is covered by inspection.
- **Engine** (`packages/sre-agent/tests/engine.test.ts`): untouched — the
  `SubAgentEvent` emission tests still pass (engine unchanged).

## Out of scope

- Engine/`SubAgentEvent` changes.
- A verbose/debug mode to re-enable steps (event stream remains available if
  wanted later).
- Streaming the sub-agent's narration.
