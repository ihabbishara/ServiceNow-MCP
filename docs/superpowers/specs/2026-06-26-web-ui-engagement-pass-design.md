# Web UI Engagement Pass — Design

Date: 2026-06-26
Branch: `worktree-session-2026-06-24`
Package: `@sre/web` (`packages/web`)

## Problem

The Spec A web shell works but reads poorly:

1. **Dead air while waiting.** When a turn runs, nothing indicates the engine is
   working until the first streamed token arrives. The user cannot tell whether
   it is thinking or stuck.
2. **Unreadable assistant output.** Assistant text is raw markdown rendered as a
   plain string inside an `inline-block` span. Newlines collapse, tables print
   as `|`-delimited noise, and everything stacks into a wall.
3. **Thin top nav.** A horizontal Chat/Settings bar carries no operational
   context (which integrations are live, what model, what commands exist).

## Goals

- Show that the engine is doing something during a turn (and what).
- Render assistant markdown as readable formatted text, including GFM tables.
- Replace the top nav with a left sidebar surfacing integration status, model,
  and the available workflow commands.

## Non-goals

- Live health-checks of integrations. Status is **configured-derived**, not a
  network probe. (A real probe is Spec B-scale and deferred.)
- Spec B data panels / Spec C dashboard. Unchanged.
- Multi-user. Single-engine ceiling stays.

## Decisions (from brainstorming)

- **Integration status = configured-derived.** Green = config/credentials
  present; gray = absent. Honest label is "configured", not "reachable".
- **Sidebar replaces the top bar** (authed only). Workflow commands are
  **clickable** and insert their template into the chat input.
- **Markdown via `react-markdown` + `remark-gfm`.** Hand-rolling a parser was
  rejected (tables + nested lists are real work). `@tailwindcss/typography` was
  rejected (pulls default palette + extra config, would dirty the design grep).
- **A green `success` token is added** to the palette. The ING "Orange Direct"
  palette has no green; the user explicitly wants green "connected" dots. Added
  as a *named semantic token* (`bg-success`), which does not match the design
  grep `(bg|…)-(…|green|…)-[0-9]` (no digit), so the grep stays clean.

## Design-system constraints (binding)

These Spec A rules carry over and must hold:

- **No default-palette classes.** `grep -rnE '(bg|text|border|ring)-(blue|gray|red|green|amber|slate|zinc|indigo|purple)-[0-9]' packages/web/client/src`
  must stay empty. New tokens are named (e.g. `success`), never raw.
- **No emoji.** Status dots are styled `<span>` elements (`rounded-full`, sized,
  background-colored), not unicode bullets or emoji.
- **Respect `prefers-reduced-motion`.** The busy/thinking animation is gated
  (`motion-safe:animate-…`); reduced-motion users see a static label.

## Design

### 1. Markdown rendering

- Add `react-markdown` and `remark-gfm` to `packages/web/client` deps.
- New `client/src/views/Markdown.tsx`: wraps `<ReactMarkdown remarkPlugins={[remarkGfm]}>`
  with a `components` map styling each element using **only ING design tokens**
  (so the default-palette grep stays empty):
  - headings (`h1`–`h3`), `p` with vertical rhythm, `ul`/`ol`/`li`
  - inline `code` and `pre` blocks (surface-container background)
  - `table`/`thead`/`th`/`td` with `border-outline` cells — the key fix
  - `a` links in `text-primary-container`, `target=_blank rel=noreferrer`
- `Chat.tsx`: assistant and streaming bubbles render through `<Markdown>` as a
  **block** element (full column width), not `inline-block`. User bubbles stay
  plain text, right-aligned, in the primary container bubble.
- Partial/streaming markdown is rendered through the same component each delta;
  react-markdown tolerates incomplete markdown.

### 2. Thinking / busy affordance

- `ChatState` gains `busy: boolean` and `activeTool?: string`.
- Reducer transitions:
  - `user-message` (client echo) → `busy = true`
  - `tool-start` → `activeTool = name` (previously a no-op)
  - `delta` → unchanged text append; `activeTool` cleared on first delta of a
    streamed answer (a tool result has started rendering)
  - `turn-end` / `turn-error` → `busy = false`, `activeTool = undefined`
- `Chat.tsx`: while `busy && !streaming`, render an animated indicator in the
  assistant column — three pulsing dots plus a label: `Running <tool>…` when
  `activeTool` is set, else `Thinking…`. Styled with ING tokens; animation via
  Tailwind (`animate-pulse` / staggered dots).
- Snapshot/reconnect does not restore `busy` (single user; acceptable — a closed
  tab mid-turn loses the indicator, not the answer).

### 3. Left sidebar

- New server event in `shared/events.ts`:
  ```ts
  | { type: "config-status"; llmMode: "seat" | "byok"; model: string;
      servicenow: boolean; ado: boolean; rag: boolean }
  ```
- `engine-host.ts` derives and emits it on `start()` and after `restart()`, and
  caches it for `snapshot()` (alongside `lastEngineState` / `lastAuthStatus`):
  - `servicenow` = `!!config.raw.SERVICENOW_BASE_URL`
  - `ado` = `adoAuthMode === "pat" ? !!raw.ADO_PAT : !!(raw.ADO_ORG_URL && raw.ADO_PROJECT)`
  - `rag` = `!!runtime` (knowledge runtime constructed)
  - `llmMode` = `config.llm.mode`, `model` = `config.llm.model`
- `state.ts`: store `config?: { llmMode; model; servicenow; ado; rag }` from the
  event.
- New `client/src/views/Sidebar.tsx` (rendered only when authenticated):
  - Brand "SRE Agent"
  - Nav: **Chat** / **Settings** (drives the existing `tab` state)
  - **Integrations** block — one row each with a status dot:
    - ServiceNow ● (green if `config.servicenow`)
    - Azure Boards ● (green if `config.ado`)
    - LLM ● — label `Copilot · <model>` (seat) or `<provider> · <model>` (byok)
    - RAG ● (green if `config.rag`)
    - Dot = a `rounded-full` span (no emoji): `bg-success` when configured,
      `bg-outline-variant` (muted) when not.
  - **Workflows** block — `/triage`, `/review`, `/postmortem`, `/handover`,
    each a button that inserts `"<cmd> "` into the chat input.
  - Footer: engine state + login (moved from the old top-right span).
- `App.tsx`:
  - Layout becomes a flex **row**: `<Sidebar>` (`w-64`, full height) + `<main>`.
  - The chat `input` string lifts from `Chat.tsx` into `App` so a sidebar
    workflow click can set it; `Chat` receives `input` + `setInput`.
  - Pre-auth: `Login` renders full-screen, no sidebar (unchanged gating).
  - Reconnect banner + ambient-env warning stay at the top of `<main>`.

## Data flow

```
user click /triage  ── App.setInput("/triage ") ──> Chat input
user send           ── ClientEvent user-message ──> reducer busy=true
engine               ── tool-start ──> reducer activeTool   ──> "Running web_fetch…"
engine               ── delta ──> reducer streaming (+clear activeTool) ──> <Markdown>
engine               ── turn-end ──> reducer commit message, busy=false
engine start/restart ── config-status ──> reducer config ──> Sidebar dots/model
```

## Error handling

- `turn-error` clears `busy`/`activeTool` and surfaces the existing error row.
- Missing/partial `config` (event not yet arrived): dots render gray, model
  shows a neutral placeholder; no crash.
- Markdown render errors are contained to the bubble (react-markdown is pure);
  malformed markdown degrades to text, never throws.

## Testing

- `tests/state.test.ts` (reducer): `user-message` sets `busy`; `tool-start` sets
  `activeTool`; `delta` clears `activeTool`; `turn-end`/`turn-error` clear both;
  `config-status` stored.
- `tests/engine-host.test.ts`: `config-status` emitted on `start()` with correct
  derived booleans for representative configs; present in `snapshot()`.
- Markdown rendering and sidebar layout verified live in the browser through a
  real Copilot seat (handoff smoke flow), plus the design-token grep must stay
  empty.

## Touched files

- `docs/DESIGN.md` + `packages/web/tailwind.config.js` — add `success`
  (`#386a20`), `on-success` (`#ffffff`), `success-container` (`#b7f397`),
  `on-success-container` (`#042100`) M3 green tokens.
- `packages/web/shared/events.ts` — add `config-status`.
- `packages/web/server/engine-host.ts` — derive + emit + snapshot `config-status`.
- `packages/web/client/src/state.ts` — `busy`, `activeTool`, `config`; reducer.
- `packages/web/client/src/App.tsx` — sidebar layout, lift `input`.
- `packages/web/client/src/views/Chat.tsx` — Markdown bubbles, busy indicator,
  controlled input.
- `packages/web/client/src/views/Sidebar.tsx` — new.
- `packages/web/client/src/views/Markdown.tsx` — new.
- `packages/web/client/package.json` — `react-markdown`, `remark-gfm`.
