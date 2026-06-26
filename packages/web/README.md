# @sre/web

Localhost browser UI for the SRE agent. Wraps the existing `ChatEngine`:
device-flow GitHub Copilot login (no CLI install), BYOK, streaming chat,
write-confirm, and a `.env` editor. Styled to the ING "Orange Direct" design
system (`docs/DESIGN.md`).

## Run

    npm run build --workspace @sre/web
    npm start --workspace @sre/web   # serves http://127.0.0.1:4317

Dev (hot client + API proxy):

    npm run dev --workspace @sre/web

(Set `WEB_PORT` to override 4317.)

## How it works

The server is a stdlib-`http` process bound to `127.0.0.1`. It owns one
`ChatEngine` via `engine-host.ts` and serves the built Vite/React client.
Server→client uses SSE (`GET /api/stream`); client→server uses POST. The
bundled `@github/copilot` runtime is a transitive dependency — no separate
Copilot CLI install is required.

## Auth

- **Copilot (default):** the device-flow login surfaces a `github.com/login/device`
  URL + user code in the UI; the bundled runtime stores the credential in
  `COPILOT_HOME`, so login is one-time per machine.
- **BYOK:** set `LLM_MODE=byok` + `LLM_PROVIDER`/`LLM_BASE_URL`/`LLM_API_KEY`
  (via the in-UI `.env` editor or the file) to use your own model key — no
  GitHub seat needed.

## Notes

- Binds `127.0.0.1` only; no app password — the Copilot login is the only auth.
- The `.env` editor reads/writes every var, including secrets. Loopback only.
- One shared engine / one in-flight turn (single-user). See the design spec for
  the multi-user upgrade path:
  `docs/superpowers/specs/2026-06-25-web-shell-auth-chat-design.md`.
