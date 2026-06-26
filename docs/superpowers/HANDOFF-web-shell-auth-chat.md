# Handoff — SRE Agent Web UI (Spec A: web shell + auth + chat)

> Paste this whole file as the opening prompt for a fresh session to continue the work. It is self-contained: what was built, why, where, and what's next.

## 1. What this is

A new `@sre/web` workspace package: a **localhost browser UI** for the existing SRE agent (`@sre/sre-agent`). It wraps the agent's existing `ChatEngine` so a non-technical user (e.g. a manager) can use it from a browser with **no Copilot CLI install** — the `@github/copilot` runtime is a transitive dependency the SDK spawns server-side.

Features delivered: device-flow GitHub Copilot login, BYOK (bring-your-own model key), streaming chat with write-confirm, and an in-UI `.env` editor. Styled to the ING "Orange Direct" design system.

This is **Spec A of three**. B (read-only data panels) and C (dashboard composition) are deferred — see §9.

## 2. Status

- **Branch:** `worktree-session-2026-06-24` (git worktree), base `main` (`2192b8a`).
- **25 commits**, 11 TDD tasks + final whole-branch review + 8 post-review fixes (2 found by live browser testing).
- **Verified:** full monorepo build green; full suite **267 tests / 51 files passing**; design-compliance grep clean (no default Tailwind palette colors); live browser smoke through a real Copilot seat — login state syncs, chat streams, user+assistant bubbles render, console clean.
- **Not yet merged.** Awaiting the finish decision (merge / PR / keep / discard).

## 3. Design system followed — ING "Orange Direct" (BINDING)

Source of truth: `docs/DESIGN.md` (front-matter tokens + guidance). Aesthetic: refined corporate-modern / Swiss-minimal — flat tonal layers with 1px borders (no heavy shadows), 8px spacing rhythm, orange used sparingly. Validated against the `ui-ux-pro-max` UX rubric and the `frontend-design` taste skill.

Tokens are copied **verbatim** into `packages/web/tailwind.config.js` as semantic names (never raw hex in components):
- **Color:** `primary #a53d00`, `primary-container #ff6200` (the brand CTA orange), `on-primary #ffffff`; `secondary #57569f` / `deep-indigo #525199`; `error #ba1a1a`; surfaces `background/surface #fbf9f8`, `surface-container-lowest #ffffff`, `surface-gray #F0F0F0` (card borders); text `on-surface #1b1c1c`, `on-surface-variant #5a4137`; `outline #8f7065`.
- **Type:** Hanken Grotesk, self-hosted via `@fontsource-variable/hanken-grotesk` (works offline). Scale: `display-lg 48/700/-0.02em` … `label-sm 12/500`.
- **Shape:** soft `0.25rem` default radius; cards `0.5rem`.
- **Conventions:** primary button `bg-primary-container text-on-primary rounded`; secondary `border-primary-container text-primary-container`; input `border-outline` + `focus-visible:border-primary-container`; card `bg-surface-container-lowest border-surface-gray` (no shadow); modal scrim `bg-black/50`; device code is a large tracked tabular-mono focal element on Login.
- **Enforcement:** `grep -rnE '(bg|text|border|ring)-(blue|gray|red|...)-[0-9]' packages/web/client/src` must be empty. Keep it that way.

## 4. Architecture

The CLI (`packages/sre-agent/src/cli/index.ts`) is the reference: load config → build tools → `ChatEngine` → start → turn loop, via `confirm`/`onDelta`/`onToolStart` callbacks. **The web layer is a second consumer of that same engine** — terminal I/O swapped for HTTP.

```
Browser (React/Vite) ── SSE (server→client stream) ──┐
        │  POST (chat/confirm/abort/login/env)        │
        ▼                                             ▼
packages/web/server (stdlib http, 127.0.0.1:4317)
        └─ engine-host.ts ── owns ONE ChatEngine + core runtime,
                              SSE event bus, pending-confirm map, single-turn gate
                                   │
                                   ▼
                 @sre/sre-agent ChatEngine ──> bundled @github/copilot runtime ──> Copilot API
```

- **Transport:** SSE (`GET /api/stream`) for server→client; POST for client→server. Single user, single shared engine, one in-flight turn (deliberate ceiling, documented; multi-user is the B/C upgrade path).
- **Binding:** `127.0.0.1` only, no app password — the Copilot device-flow login is the only auth.

## 5. Auth model

- **Device flow (default):** `copilotLogin` (in `auth.ts`) spawns the bundled runtime, parses the `github.com/login/device` URL + user code from stdout, emits a `device-code` SSE event the UI renders. The runtime stores the credential in `COPILOT_HOME` → login is one-time per machine. **The app server never sees the raw GitHub token.** Token types accepted: `gho_`, `ghu_`, `github_pat_` (not classic `ghp_`).
- **BYOK:** set `LLM_MODE=byok` + `LLM_PROVIDER`/`LLM_BASE_URL`/`LLM_API_KEY` (via the UI `.env` editor or file) to use OpenAI/Azure/Anthropic directly — no Copilot seat needed. Already wired in `engine.ts` (attaches `provider` to the session).

## 6. Important files

**New package `packages/web/`:**
- `shared/events.ts` — `ServerEvent` discriminated union; the single SSE contract shared by server emit + client reducer. Start here to understand the data flow.
- `server/engine-host.ts` — **the heart.** Owns the `ChatEngine`, SSE bus, confirm-map, turn gate, lifecycle (`start/stop/restart/login/applyEnv`), and `snapshot()` (replays current `engine-state`+`auth-status` to a newly-connected client). Generation-guarded `turnRunning` so a restart can't corrupt the busy gate.
- `server/routes/{chat,auth,env,util}.ts` — HTTP handlers. `chat.ts` has the SSE stream + the `isTurnRunning()` 409 busy-gate + the snapshot replay on connect.
- `server/index.ts` — `createApp` (router) + `startServer` (binds 127.0.0.1, real bootstrap when no host injected) + the `WEB_PORT` (default 4317) entrypoint guard.
- `server/sse.ts` — `SseHub` broadcaster + `formatSse`.
- `server/static.ts` — static file serving with correct `content-type` (MIME map) + SPA fallback. **Don't reinline content-type logic elsewhere.**
- `server/dotenv-file.ts` — `.env` parse/serialize/read/write with **symmetric quoting/escaping** (handles secrets with spaces/`#`/`=`/quotes/newlines).
- `client/src/state.ts` — pure `applyServerEvent(state, event)` reducer (the only client unit test). Accepts `ServerEvent | ClientEvent` (the `user-message` client event echoes the user's own prompt).
- `client/src/sse.ts` — `useServerStream()` hook: opens `EventSource`, returns `{ state, connected, send }`. `connected` drives a reconnect banner (transport ≠ turn error).
- `client/src/views/{Login,Chat,ConfirmDialog,EnvSettings}.tsx` + `App.tsx` — the ING-styled UI. Nav hidden until authenticated.
- `tailwind.config.js` — the ING token theme (verbatim from DESIGN.md).

**Modified in `packages/sre-agent/` (the only edits to pre-existing code):**
- `src/engine/auth.ts` — `copilotLogin` device-code capture (`stdio` pipe + `parseDeviceCode` + `onDeviceCode`); CLI behavior preserved.
- `src/cli/index.ts` — callsite passes an `onDeviceCode` that prints to stdout.
- `src/index.ts` — **new** public API barrel (so `@sre/web` can import `ChatEngine`, `loadAgentConfig`, `buildTools`, `copilotLogin`, etc.); `package.json` got `main`/`types`/`exports`.

**Docs:**
- `docs/DESIGN.md` — ING design system.
- `docs/superpowers/specs/2026-06-25-web-shell-auth-chat-design.md` — the approved design spec.
- `docs/superpowers/plans/2026-06-25-web-shell-auth-chat.md` — the 11-task TDD implementation plan.
- `.superpowers/sdd/progress.md` — the task-by-task ledger (commits + review notes + deferred minors). Gitignored.

**Repo-wide:** `vitest.workspace.ts` (registers all 4 packages with `@sre/core`/`@sre/sre-agent` src aliases); `.gitignore` now ignores `.env`.

## 7. How to run / test

```bash
npm install            # if fresh
npm run build          # all workspaces (tsc -b + Vite)
npm test               # 267 tests, 51 files

# Run the UI (needs a .env that passes loadAgentConfig):
npm start --workspace @sre/web         # serves http://127.0.0.1:4317 (WEB_PORT to override)
# dev (hot client + /api proxy): npm run dev --workspace @sre/web
```
A **dummy** `packages/sre-agent/.env` exists for UI/login testing (fake ServiceNow values, `ADO_AUTH_MODE=pat`, `LLM_MODE=seat`) — it's gitignored. Real values go in via the UI `.env` editor (or the file). ServiceNow/ADO *tools* won't work with dummy creds, but login + chat + the editor do.

Stop a backgrounded server: `pkill -f dist/server/index.js`.

## 8. What was actually done (commit map)

Build order (each task: implementer subagent → spec+quality review → fixes):
1. `a5b98c6` sre-agent exports barrel → 2. `35c3b0c` parseDeviceCode → 3. `d432bc1` copilotLogin device-code capture → 4. `1015b54`/`73eab42` web scaffold + ING theme + static content-type fix → 5. `3404251` SSE hub → 6. `0fb3c85` .env io → 7. `b4eb837`/`66d4091` engine-host core (+ timeout/turn-error tests) → 8. `2b36d9a` engine-host lifecycle → 9. `55cbaa9`/`477b905` HTTP routes + wiring → 10. `3c73abf`/`2c03ad4` React client (+ SSE error/a11y) → 11. `eb3eb15` README + e2e.

Final whole-branch review (opus) → 2 blockers fixed `c19491d` (restart-vs-turn race; `.env` quote round-trip). Then live browser testing found + fixed 8 issues `e3b0865` + `5859176` (boot-state sync, nav gating, stable keys, reconnect banner, user-message echo, + minor cleanups), plus `2e12421` gitignore `.env`.

## 9. Deferred / out of scope (next work)

- **Spec B — read-only data panels:** stale tickets, ADO bugs, knowledge stats as views; new read endpoints exposing `@sre/core` services. Its own spec → plan → build.
- **Spec C — dashboard composition:** layout, tables, filters, charts tying chat + panels together.
- **Deferred minors (non-blocking, in the ledger):** none currently merge-blocking; all the final review's must-fix items were fixed. Remaining nice-to-haves were resolved in the post-review wave.
- **Multi-user:** the single-engine ceiling is deliberate. For a shared server, move to per-session `gitHubToken` + `mode: "empty"` (see the design spec §"multi-user upgrade path" and copilot-sdk `docs/setup/multi-tenancy.md`).

## 10. Gotchas for whoever continues

- ESM + NodeNext throughout: import local files with `.js` specifiers even from `.ts`.
- Two build systems in `packages/web`: server is `tsc -b` (`server/`+`shared/` only); client is Vite (`tsconfig.node.json`, noEmit). Keep them separate.
- The `ServerEvent` union (`shared/events.ts`) is the contract — change it in one place, both server and client follow.
- The write-confirm round-trip: `confirm()` parks a Promise in a Map keyed by id, resolved by `POST /api/confirm`; timeout → `false` (decline). Don't let a closed tab wedge a turn.
- `engine-host.restart()` runs on every login and `.env` save — it aborts any in-flight turn, disposes the ONNX runtime before rebuild, and bumps the turn generation. Respect that when extending.
- Never commit a real `.env`. Never reinline static content-type handling (use `serveStatic`). Keep the design grep clean.

## 11. Decision pending

Branch is ready. Options: merge to `main` locally, push + open a PR, keep as-is, or discard.
