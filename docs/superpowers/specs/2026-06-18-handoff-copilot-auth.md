# Handoff — SRE agent Copilot seat auth (2026-06-18)

Paste the block below into a fresh Claude Code session to continue.

---

```text
CONTINUE an in-progress project. Read this fully before acting.

## What this project is
Repo: github.com:ihabbishara/ServiceNow-MCP (branch `main`, ~HEAD 99235bf).
Local dev box: macOS at /Users/ihabbishara/projects/ServiceNowMCP. The USER also
runs it on WINDOWS (PowerShell) at C:\work\git\SRE\P32377-PSSSRE-SNChatbot (and a
second clone C:\work\git-public\ServiceNow-MCP). Node v22.22 on Windows.

It is an npm WORKSPACES monorepo that repackaged a ServiceNow/Azure-DevOps MCP
server (org blocked MCP) into a standalone CLI chatbot on the official GitHub
Copilot SDK (@github/copilot-sdk@1.0.1):
- packages/core      — ServiceNow + ADO clients, domain services, config, types (zod v3)
- packages/mcp-server — original MCP adapter, kept
- packages/sre-agent — the new Copilot-SDK chatbot (zod v4): 12 defineTool tools,
  a ChatEngine over CopilotClient, a y/N write gate, 4 workflow slash-commands, a REPL CLI.
ADO uses the `az boards` CLI under `az login` (NO PAT). Full design + plan:
docs/superpowers/specs/2026-06-17-sre-agent-copilot-sdk-design.md and
docs/superpowers/plans/2026-06-17-sre-agent.md. Build prompt:
docs/superpowers/specs/2026-06-17-sre-agent-build-prompt.md.

## State: it builds, tests pass (122), and on Windows it now STARTS cleanly:
  [sre-agent] config ok (llm=seat/gpt-5, ado=azcli)
  [sre-agent] checking Azure CLI login (az account show)… → az login ok
  [sre-agent] connecting to Copilot (seat mode, model gpt-5)… → SRE agent ready. >
Already solved on the way here (don't redo): TS project references so per-package
builds work (`tsc -b`); run dist/cli/index.js NOT index.d.ts; .env is NOT auto-loaded
(run `node --env-file=packages/sre-agent/.env packages/sre-agent/dist/cli/index.js`);
empty-string env vars coerced to unset in agent config; Windows `az` is `az.cmd` so
core/src/clients/ado/az.ts routes az through cmd.exe with quoted verbatim args.

## THE CURRENT BLOCKER (your task)
Every chat turn fails:
  [sre-agent] turn failed: Authorization error, you may need to run /login (Request ID: …)
Diagnosis CONFIRMED by the user: the standalone GitHub Copilot CLI (`copilot`) CHATS
FINE for this user (so the seat IS authorized — NOT an org-policy/entitlement block).
The error carries a backend Request ID = a token is sent but the SDK's session is using
a credential the Copilot backend rejects. So: the SDK (`new CopilotClient()` in
packages/sre-agent/src/engine/engine.ts) is NOT using the same working credential the
`copilot` CLI uses.

## SDK auth facts already gathered (from node_modules/@github/copilot-sdk/dist/*.d.ts)
- CopilotClientOptions has `gitHubToken?` and `useLoggedInUser?`. With gitHubToken set,
  the SDK passes env COPILOT_SDK_AUTH_TOKEN and adds `--no-auto-login`. With
  useLoggedInUser !== false it AUTO-LOGS-IN as the logged-in user.
- Auth resolution order: explicit gitHubToken → HMAC (CAPI_HMAC_KEY) → direct API token
  (GITHUB_COPILOT_API_TOKEN+COPILOT_API_URL) → env tokens
  (COPILOT_GITHUB_TOKEN→GH_TOKEN→GITHUB_TOKEN) → stored OAuth from `copilot` CLI login →
  `gh auth`. Token prefixes accepted: gho_, ghu_, github_pat_ (NOT ghp_).
- There is a session auth-status RPC ("Gets authentication status and account metadata
  for the session") and `client.listModels()`/quota methods — usable to validate auth.
- The engine currently calls `new CopilotClient()` with NO options (pure auto-detect).

## YOUR TASK (two parts)
1. FIX seat auth so the SDK uses the SAME working credential the `copilot` CLI uses.
   Investigate, on a machine where `copilot` chat works (the USER's Windows box — you
   cannot reproduce this on the Mac, you have no seat): where/what credential the working
   `copilot` CLI uses (its config/cred store, COPILOT_HOME/~/.copilot, whether it's the
   same bundled @github/copilot the SDK spawns, and whether a token can be exported).
   Likely fixes to evaluate: (a) pass an explicit `gitHubToken` to CopilotClient from a
   new config var (e.g. COPILOT_GITHUB_TOKEN / GH_TOKEN) the user can fill; (b) ensure the
   SDK's bundled runtime auto-login reads the same store as the standalone `copilot` (e.g.
   set COPILOT_HOME, or run the SDK's OWN bundled `copilot login` rather than a different
   global one); (c) detect the 403 and surface an actionable message.
2. ADD an in-tool login UX the user explicitly asked for — mirror the `az` doctor: if the
   Copilot session is not authorized, run the Copilot device-flow login FROM the tool
   (print the github.com/login/device URL + code, wait), then proceed — using the SAME
   binary/store the SDK reads. Add a `/login` command too. (Note: only helps if part 1
   shows the CLI credential is reusable, which the user's working `copilot` chat implies.)

## METHOD / CONVENTIONS (follow the existing repo)
- TypeScript ESM, NodeNext, explicit .js imports. sre-agent = zod v4; core = zod v3; NEVER
  cross a zod schema over the package boundary.
- TDD: unit-test against injected fakes (see packages/core/tests/clients/az.test.ts and
  packages/sre-agent/tests/*). The Copilot SDK is faked in engine tests via a `clientFactory`
  seam already on EngineDeps (packages/sre-agent/src/engine/engine.ts) — use it.
- Build: `npm run build` (root) or `tsc -b`. Test: `npm test` (must stay green, 122+).
- You CANNOT test live Copilot auth on the Mac (no seat). The USER is the Windows
  integration tester — give them exact PowerShell commands and a build that prints clear
  breadcrumbs; iterate from their pasted output. Don't claim it works without their confirm.
- Commit straight to main (user's preference), small focused commits, message trailer:
  Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
- Keep BYOK (Azure OpenAI) as the documented fallback (LLM_MODE=byok) in case the seat path
  proves unworkable — the org runs Azure (ADO org INGCDaaS).

## FIRST STEPS
- Read packages/sre-agent/src/engine/engine.ts (CopilotClient creation), config.ts, cli/index.ts,
  doctor.ts; and node_modules/@github/copilot-sdk/dist/client.d.ts + types.d.ts for the auth API.
- Ask the user (Windows) to report: which `copilot` binary works (`Get-Command copilot`), its
  version, and whether `node_modules/@github/copilot` (the SDK's bundled runtime) is the same;
  plus whether `gh auth token` yields a token. Use that to choose fix (a)/(b).
```

---
```
