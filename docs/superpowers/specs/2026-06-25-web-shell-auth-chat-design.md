# Spec A — Web shell + auth + chat

**Date:** 2026-06-25
**Status:** Approved (design); implementation plan pending
**Scope:** First sub-project of the "full dashboard" web UI for the SRE agent. Delivers a browser front door for the existing `ChatEngine`: device-flow / BYOK auth, streaming chat, write-confirm, and a `.env` editor. Data panels and dashboard composition are deferred (specs B and C).

## 1. Background & motivation

The SRE agent (`@sre/sre-agent`) is a CLI REPL today. Managers want a browser UI and do not want to install anything. They don't have to: on Node the Copilot runtime (`@github/copilot`) is a **transitive dependency** already on disk (`node_modules/@github/copilot/index.js`); the SDK spawns it as a server-side child process. So a localhost web app needs no separate Copilot CLI install — only Node + the app.

`ChatEngine` (`packages/sre-agent/src/engine/engine.ts`) is already front-end-agnostic: it emits events (`onDelta`, `onToolStart`) and takes a `confirm` seam, and BYOK is fully wired (`provider` attached to the session when `LLM_MODE=byok`). The web layer is therefore a **second consumer** of the same engine the CLI (`packages/sre-agent/src/cli/index.ts`) drives — terminal I/O swapped for HTTP.

### Deployment decisions (fixed inputs to this design)

- **Topology:** each manager runs their own local instance (one user per process).
- **Auth:** GitHub Copilot device flow (primary) + BYOK (kept as an alternative for anyone without a Copilot seat).
- **Seats:** managers should have Copilot seats; BYOK capability is retained regardless.
- **Frontend:** React + Vite + Tailwind (correct floor given the dashboard endgame in B/C).
- **Transport:** SSE (server→client stream) + POST (client→server).
- **Binding:** `127.0.0.1` only, no app-level password — the device-flow login is the only auth.
- **Config/secrets:** `.env` file, with a UI editor over **all** vars.
- **Packaging:** new `packages/web` workspace.
- **Design system:** the UI **must** follow the ING "Orange Direct" system in `docs/DESIGN.md` (the source of truth). Verified against the `ui-ux-pro-max` UX rubric and the `frontend-design` taste skill.

## 1a. Design system — ING "Orange Direct" (binding)

`docs/DESIGN.md` is authoritative; its tokens are copied into the Tailwind theme verbatim (semantic names, never raw hex in components). Aesthetic direction: **refined corporate-modern / Swiss-minimal** — generous whitespace on an 8px rhythm, flat tonal layers with 1px borders (no heavy shadows), orange used sparingly and with intent.

**Tokens (from DESIGN.md):**
- **Color:** `primary #a53d00`, `primary-container #ff6200` (the brand CTA orange), `on-primary #ffffff`; `secondary #57569f` / `deep-indigo #525199` (informational tags); `error #ba1a1a`; surfaces `background/surface #fbf9f8`, `surface-container-lowest #ffffff`, `surface-gray #F0F0F0` (card borders); text `on-surface #1b1c1c`, `on-surface-variant #5a4137`; `outline #8f7065`, `outline-variant #e3bfb1`.
- **Type:** Hanken Grotesk, self-hosted via `@fontsource`. Scale: `display-lg 48/700/-0.02em`, `headline-lg 32/700`, `headline-md 24/600`, `body-lg 18/400`, `body-md 16/400`, `label-md 14/600`, `label-sm 12/500`. Heavy weights (600–700) for headings; tight tracking on large display.
- **Shape:** soft `0.25rem` default radius; cards may use `0.5rem`; pills reserved for status tags only.
- **Elevation:** borders over shadows. Cards: white bg + 1px `surface-gray` border, no shadow. Floating (modal/dropdown): one soft diffuse ambient shadow at 5–8% alpha.
- **Spacing:** 8px base unit; desktop max-width 1200px.

**Component conventions:**
- **Primary button:** `bg-primary-container text-on-primary rounded` (solid #ff6200, white text); hover darkens slightly. One primary CTA per screen.
- **Secondary button:** transparent bg, 1px `primary-container` border + `primary-container` text.
- **Input:** 1px neutral (`outline`) border, `rounded`; on focus → `primary-container` border + a 2px semi-transparent orange focus ring (`focus-visible` only).
- **Card:** `surface-container-lowest` bg, 1px `surface-gray` border, no shadow; border darkens on hover when interactive.
- **Tag/Chip:** informational = `deep-indigo` bg / white text; inactive filter = light gray. Pill shape.
- **Signature moment:** the device-flow **user code** renders large, letter-spaced, tabular-figure mono as the login focal element.

**UX rules enforced (from `ui-ux-pro-max`):** 4.5:1 text contrast, visible focus rings (2–4px), visible input labels with error shown below the field, modal scrim 40–60% black, skeleton/progress for waits > 300ms, `prefers-reduced-motion` respected, SVG icons only (no emoji), press states that don't shift layout.

## 2. Architecture & components

```
packages/web/
  server/                     Node, stdlib http (no framework — add Fastify only if routing hurts)
    index.ts                  127.0.0.1 server; serves client build + /api
    engine-host.ts            owns ONE ChatEngine + core runtime; start/stop/restart, turn state,
                              the pending write-confirm map
    routes/
      chat.ts                 POST /api/chat, GET /api/stream (SSE), POST /api/abort, POST /api/confirm
      auth.ts                 GET /api/auth/status, POST /api/auth/login
      env.ts                  GET/PUT /api/env
    sse.ts                    minimal SSE broadcaster (fans out to connected stream(s))
    dotenv-file.ts            read/parse/write the .env file (locate via the same path loadDotenv uses)
  client/                     Vite + React + Tailwind
    src/ ... Chat, Login, EnvSettings, ConfirmDialog views
  package.json                depends on @sre/sre-agent + @sre/core
```

**`engine-host.ts`** holds the stateful bits the CLI keeps in `main()`'s closure (the engine, the core runtime, the "is a turn running" flag, the SIGINT/abort hook, the pending-confirm map). HTTP handlers are stateless and call into it. This is the core REPL→server structural translation.

**Concurrency ceiling:** one server, one `ChatEngine`, one session, one in-flight turn. Two browser tabs share that engine. Acceptable for single-user local use; marked in code as `// ponytail: single shared engine, per-session if this ever goes multi-user`.

**Server framework:** stdlib `http`. Four routes + static files + SSE need no router; SSE is `res.write("data: ...\n\n")`. A framework earns its place at B/C when routes multiply.

## 3. API contract

### `GET /api/stream` (SSE) — server→browser events

| event | payload | meaning |
|---|---|---|
| `delta` | `{text}` | assistant token (`onDelta`) |
| `tool-start` | `{name}` | tool began (`onToolStart`) |
| `turn-end` | `{}` | session idle, turn complete |
| `turn-error` | `{message, isAuthError}` | turn threw; `isAuthError` from `isCopilotAuthError` |
| `confirm-request` | `{id, summary}` | write gate awaiting approval |
| `device-code` | `{verificationUri, userCode, expiresIn}` | login in progress |
| `auth-status` | `{isAuthenticated, authType, login, ambientEnvWarning}` | seat status |
| `engine-state` | `{state}` | `starting` \| `ready` \| `restarting` \| `error` (+ `message` when `error`) |

### Request routes

| route | body | action |
|---|---|---|
| `POST /api/chat` | `{prompt}` | expand via `buildWorkflowPrompt` (keeps `/triage` etc.), then `engine.send`; returns `409` if a turn is already running |
| `POST /api/confirm` | `{id, approve}` | resolve the pending write-confirm promise for `id` |
| `POST /api/abort` | — | `engine.abort()` |
| `POST /api/auth/login` | — | run `copilotLogin` with device-code→SSE, then restart engine, emit `auth-status` |
| `GET /api/auth/status` | — | `engine.getAuthStatus()` |
| `GET /api/env` | — | parsed `.env` key/values (all vars) |
| `PUT /api/env` | `{vars}` | write `.env` → validate → restart engine (see §4.3) |

## 4. Non-obvious data flows

### 4.1 Write-confirm round-trip

`ChatEngine` calls `confirm(summary): Promise<boolean>` **mid-turn** and blocks until a human answers (today: `rl.question` y/N in the CLI). In `engine-host`:

1. `confirm` mints an `id`, emits `confirm-request {id, summary}` over SSE, and returns a Promise whose resolver is parked in a `Map<id, (boolean) => void>`.
2. `POST /api/confirm {id, approve}` looks up the resolver and settles the Promise.
3. Timeout (configurable) or SSE disconnect → resolve `false`.

The timeout→`false` default mirrors the CLI's non-TTY "decline cleanly" behavior so a write never hangs the turn if the tab closes mid-confirm.

### 4.2 Device-flow login

Depends on the `auth.ts` change (§5.1). `copilotLogin` gains an `onDeviceCode(info)` callback. The server passes a callback that emits the `device-code` SSE event; the browser shows the URL + user code and auto-opens `verificationUri`. On the login process exiting `0`, the server restarts the engine and re-probes auth status — the exact sequence of the CLI's `reloginCopilot`, with SSE events instead of stderr writes.

### 4.3 `.env` edit → restart

`PUT /api/env` writes the file via `dotenv-file.ts`, then re-runs `loadDotenv` + `loadAgentConfig`:

- **Valid:** `engine-host` stops and restarts the engine, re-runs the seat preflight, emits `engine-state` and `auth-status`.
- **Invalid:** respond `400` with the Zod issues; the **running engine is left untouched** (no restart on bad config).

## 5. Changes to existing code (the entire delta)

### 5.1 `packages/sre-agent/src/engine/auth.ts`

`copilotLogin`: switch `stdio: "inherit"` → `"pipe"`, parse the `github.com/login/device` URL + user code out of the child's stdout, and invoke `opts.onDeviceCode(info)` when seen. Preserve the existing contract: resolve on exit `0`, reject on non-zero / spawn error. The CLI passes an `onDeviceCode` callback that writes the URL+code to stdout, preserving today's terminal UX. Extend `auth.test.ts` with a fake spawn that emits sample stdout.

### 5.2 `packages/sre-agent` package exports

Add `src/index.ts` barrel + an `exports` map exposing `ChatEngine`, `loadAgentConfig`, `buildTools`, `copilotLogin`, `isCopilotAuthError`, and the relevant types. No logic change; the CLI `bin` is unaffected.

Everything else is additive within `packages/web`.

## 6. Error handling

- **Turn failure** → `turn-error {message, isAuthError}`; client shows the same actionable "re-login / unset GH_TOKEN" hint the CLI prints (driven by `isCopilotAuthError`).
- **Ambient-env-token 403 trap** → when the runtime resolved `authType: "env"` and no explicit `COPILOT_GITHUB_TOKEN` is set, `auth-status.ambientEnvWarning` is true; the client renders the warning (the documented false-positive where auth "looks ok" but a non-Copilot token 403s).
- **ADO `azcli` preflight** → the browser cannot run `az login`; surface "run `az login` in a terminal" as UI guidance, not an auto-step.
- **Engine start failure** → `engine-state: error` + message.
- **Concurrent chat** → `POST /api/chat` while a turn runs returns `409 busy`.

## 7. Testing

- **`engine-host`**: reuse the existing `clientFactory` fake-engine seam (`EngineDeps.clientFactory`) — assert the confirm round-trip resolves on `POST /api/confirm`, `abort` calls `engine.abort`, and an env change triggers a restart.
- **`auth.ts`**: table-driven device-code parsing from sample stdout lines; `onDeviceCode` fired; resolve-on-0 / reject-on-nonzero contract held (extends `auth.test.ts`).
- **`env` route / `dotenv-file.ts`**: read/write `.env` round-trip in a tmp dir; invalid config → `400`, no restart.
- **Frontend**: one smoke test only (no heavy component suite for spec A).
- All under vitest, matching the existing workspace setup.

## 8. Out of scope (deferred)

| Deferred to | Items |
|---|---|
| Spec B | Read-only data panels (stale tickets, ADO bugs, knowledge stats); new read endpoints |
| Spec C | Dashboard composition: layout, tables, filters, charts |
| Not planned for own-machine | Multi-user / per-session engines, app-level password, network (`0.0.0.0`) binding, TLS |

## 9. Open considerations (non-blocking)

- **Secret rendering in the `.env` editor:** per decision, all vars (including ServiceNow password, ADO PAT, API keys) are readable/writable and render in the panel. Acceptable on loopback, no app gate. Optional future hardening: mask secret-typed values write-only. Not in scope for A.
- **Engine restart cost:** restarting on every `.env` save re-spawns the Copilot runtime (seconds on first start). Acceptable for a settings action; revisit only if it becomes a friction point.
