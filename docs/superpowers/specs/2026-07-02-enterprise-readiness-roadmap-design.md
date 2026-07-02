# Enterprise-Readiness Roadmap + Incident→Code Localization

**Date:** 2026-07-02
**Status:** Design — approved to write; phases pending per-phase plans
**Author:** SRE agent team (audit-driven)

## 1. Purpose

Turn the SRE chatbot from a capable-but-sprawling monorepo into an enterprise-ready,
future-ready application, and land the originally-requested feature —
**given a ServiceNow incident, clone a git repo and pinpoint the suspect code** —
on the hardened base instead of as a third duplicated surface.

The roadmap is sequenced foundation-first (P0→P3). The localization feature is P3
precisely because the P1 refactor makes it a single registry entry rather than
another hand-maintained twin.

## 2. Current state (audit summary, file:line-grounded)

Monorepo, 4 packages, ~10k LOC, `strict:true` ESM, TS project references. Real
logic lives only in `@sre/core`. `@sre/mcp-server` = MCP surface; `@sre/sre-agent`
= Copilot-SDK tools + `ChatEngine` + CLI; `@sre/web` reuses the sre-agent engine.

Three systemic problems (the "all over the place"):

### A. No single source of truth — logic defined 2–3×
- **Tools:** 14 shared tools defined twice — `mcp-server/src/tools/*.ts` and
  `sre-agent/src/tools/index.ts` (~350 lines mechanical copy). Drift already
  caused live bugs:
  - Copilot `create_bug_from_incident` is missing the `azureDevOps.enabled` guard
    (`sre-agent/src/tools/index.ts:472`) that MCP has (`mcp-server/src/tools/ado.ts:66-81`).
  - `search_work_items` differs materially across surfaces (required vs optional
    `query_text`, 6 vs 9 projected fields, guard present vs absent):
    `mcp-server/src/tools/ado.ts:7-52` vs `sre-agent/src/tools/index.ts:396-437`.
  - `create_work_item`/`clone_work_item`/CSV tools exist only on MCP;
    `get_work_item` only on Copilot. Neither surface is complete.
  - No parity test exists.
- **Config:** two zod schemas parse the same `process.env` —
  `core/src/config.ts` (267L) and `sre-agent/src/config.ts` (152L). CLI prints
  "config ok" then core can throw on a core-only var. Agent schema lacks
  `ADO_ENABLED`, so it can validate "ok" while core disables ADO.
- **Prompts:** 4 prompts duplicated and drifted between
  `mcp-server/src/prompts/index.ts` and `sre-agent/src/workflows/index.ts`.
- **ADO client:** `clients/ado/index.ts` (PAT) and `clients/ado/azBoards.ts` (az)
  reimplement WIQL/create-ops/mappers; two `WorkItem` projections, one lossy
  (`ado/index.ts:24-31` partial vs `ado/map.ts:25-43` full).
- No projection/DTO layer in core → each tool surface re-projects domain objects.

### B. No enterprise scaffolding
- No CI (`.github/` absent) despite native deps (better-sqlite3, sqlite-vec,
  `@huggingface/transformers` ONNX) that are OS/arch-specific.
- No ESLint/Prettier/editorconfig — zero style enforcement.
- No structured logger (8 raw `console.*` in src); no tool-call audit trail.
- No coverage gate; React client (23 files) 0% tested.
- zod v3 (core/mcp) vs v4 (sre-agent, forced by `@github/copilot-sdk@1.0.1`) —
  latent type/runtime break at the core↔agent tool boundary.
- `.env.example` stale (missing `ADO_BOARD_MAP`, `ADO_CSV_DIR`, `ADO_CSV_MAX_BYTES`,
  `COPILOT_CLI_PATH`, `WEB_PORT`). Six names for one project. No LICENSE/SECURITY.md/.nvmrc.

### C. Web security (only mitigated by loopback bind today)
- `GET /api/env` returns all secrets cleartext to the browser
  (`web/server/routes/env.ts:6-8` → `engine-host.ts:284-286`).
- `PUT /api/env` lets the browser rewrite creds/URLs/proxy then restart the engine
  (`web/server/routes/env.ts:10-15`).
- No web auth, no Origin/CSRF check (`web/server/index.ts:15-38`) → both reachable
  via DNS-rebinding. Single global engine, non-durable SSE, uncapped `/api/chat`
  body, 500 leaks `e.message` (`web/server/index.ts:36`).

Well-engineered spots to preserve: `sre-agent/src/engine/auth.ts` (ambient-token
stripping), `core/src/services/csvReader.ts` (3-layer traversal guard), embedder
serialization, Graph 429 backoff, DI-clean `ChatEngine`.

## 3. Goals / non-goals

**Goals:** single source of truth for tools/config/prompts; CI + lint + typed
errors + logging; safe web surface; then incident→code localization consistent
across CLI/MCP/web.

**Non-goals (this roadmap):** hosted multi-tenant deployment; secret-manager/vault
integration; service→repo auto-resolution (v2); code-embedding RAG (v2); rewriting
the LLM engine.

## 4. Phased plan

Each phase ships independently, is green in CI before the next starts, and gets its
own detailed implementation plan (writing-plans) when reached.

### P0 — Guardrails (backstops everything)
- **CI** `.github/workflows/ci.yml`: `npm ci && npm run build && npm test`,
  matrix Node 20/22 × {ubuntu, macos, windows} (proves native/ONNX install).
- **ESLint + Prettier** at root with `lint`/`format` scripts + CI gate;
  `.editorconfig`.
- **Resolve zod split:** pin one major or firewall the core(v3)↔agent(v4) boundary
  so core schemas never cross as instances into the agent runtime.
- **Hygiene:** `.nvmrc`; regenerate `.env.example` from schema (fix 5 missing vars);
  add root solution `tsconfig.json`; add LICENSE + SECURITY.md; `.gitignore`
  `.superpowers/`.
- **Acceptance:** green CI on all 3 OSes; `npm run lint` clean; single zod major
  resolvable at the tool boundary; `.env.example` matches the schema.

### P1 — Single source of truth (kills problem A + drift bugs)
- **Tool registry in core** `core/src/tools/registry.ts`:
  `ToolSpec<A> = { name; description; schema: ZodType<A>; write?: boolean;
  enabledWhen?(c: AppConfig): string|null; run(rt: McpRuntime, args: A): Promise<object> }`.
  One `TOOL_SPECS` table holding all projection logic once.
- **Two thin adapters:** `toMcpTool(spec)` (wraps `{content:[{type:text,...}]}` /
  `isError`); `toCopilotTool(spec)` (`skipPermission = !spec.write`; returns raw
  object / `{error}`). Rewrite `sre-agent/src/tools/index.ts` and
  `mcp-server/src/tools/*.ts` + `server.ts` to derive from the registry.
- **Reconcile the live drifts** while migrating: unify `search_work_items` schema/
  projection/guard; add the missing `azureDevOps.enabled` guard; mirror
  create/clone/csv + `get_work_item` to both surfaces via the registry.
- **Config single source:** core owns the schema; `sre-agent/src/config.ts`
  `.extend()`s it; parse `process.env` once and pass `AppConfig` into
  `createMcpRuntime(config)` (drop the re-read at `runtime.ts:28-29`).
- **Prompts single source:** one module consumed by both MCP prompts and
  sre-agent workflows.
- **Collapse ADO clients:** shared WIQL/create-ops/mapper in `clients/ado/`,
  delete the partial `mapWorkItem`; add a core projection/DTO layer for
  incident/workItem/report wire JSON.
- **Parity test:** iterate the registry, assert both adapters expose identical
  names/descriptions/schemas.
- **Acceptance:** each tool/config-var/prompt defined exactly once; parity test
  green; the three drift bugs have regression tests; ~350 lines deleted.

### P2 — Enterprise cross-cuts
- **Structured logger** (core seam) + tool-call audit `{tool, args(redacted), ms,
  ok|error}` via one decorator around `spec.run`; derive `WRITE_TOOLS` from the
  registry (`permissions.ts:4`).
- **Typed error taxonomy** (retryable/fatal/notfound) replacing bare
  `Error(string)`; one HTTP helper (timeout + backoff) for ServiceNow + ADO-PAT to
  match Graph (`servicenow.ts:128`, `ado/index.ts:54`).
- **Secret redaction** on the config object (`toJSON` masking).
- **Web hardening:** auth gate + strict Host/Origin allowlist at
  `web/server/index.ts` top; stop returning secrets from `GET /api/env` (masked +
  write-only PUT); cap `/api/chat` body; stop leaking `e.message`; SSE heartbeat +
  `Last-Event-ID` replay; per-session engine registry (replace the
  `engine-host.ts:127` singleton).
- **Tests:** pure-logic + security-logic unit tests (correlation/slaRisk/
  staleTickets/workItemService/csv traversal/WIQL+SN escaping); jsdom render tests
  for the React client; coverage gate threshold.
- **Acceptance:** tool calls audited; SN/ADO have timeout+retry; no secret leaves
  the server; coverage gate enforced in CI.

### P3 — Incident→code localization (reshaped design)

Built as one registry tool-group on the hardened base. Reshape reflects the earlier
adversarial review (security is the binding constraint; regression-window forensics
beats blame; full clone beats `--filter=blob:none`).

- **Core `RepoService`** `core/src/services/repo/` — read-only git wrappers via
  `execFile` arg arrays (no shell): `git.ts`, `cache.ts` (url→dir hash under
  `CODE_CACHE_DIR`, path confinement + LRU eviction under `CODE_CACHE_MAX_BYTES`,
  fetch-on-cache-hit), `index.ts` facade. Wired as `runtime.repo`.
- **Registry tools:** `clone_repo(url, ref?)` (**gated** — has side effects: disk +
  network + ambient creds; returns resolved SHA); read-only (`skipPermission`):
  `code_list_files`, `code_search` (git grep on checkout), `code_read_file`,
  `code_recent_commits` (incident-window), `code_diff`/`code_show_commit`,
  `code_blame` (change attribution; author names opt-in behind `CODE_SHOW_AUTHORS`).
- **Security (must-fix, non-negotiable):**
  1. `--` end-of-options at every git call site; reject any model/incident-sourced
     arg matching `/^-/` (blocks `git grep --open-files-in-pager=<cmd>` RCE,
     `--output`/`--format` file write).
  2. Transport allowlist: clone with `-c protocol.ext.allow=never
     -c protocol.file.allow=never`, `GIT_TERMINAL_PROMPT=0`; ban `ext::`,
     `file://`, `--upload-pack`. Scheme allowlist alone is insufficient.
  3. Host allowlist `CODE_ALLOWED_GIT_HOSTS` (corp hosts); reject
     localhost/127/169.254/internal. `clone_repo` gated (at minimum one-time
     confirm per never-before-seen host).
  4. Treat cloned contents (incl. `.git/config`, read files) as untrusted
     indirect-injection input.
- **Clone strategy:** full clone (bounded by cache size + LRU eviction), NOT
  `--filter=blob:none` (documented anti-pattern: blame issues per-blob network
  requests; git-backfill man page). blob:none deferred to v2 for monorepos +
  `git backfill`.
- **Ranking:** lead with regression-window forensics (incident `opened_at` +
  deployed ref → `git log` range ranked by stack-trace-symbol overlap); blame
  demoted to change attribution. Add `/rca` workflow prompt (registry-driven).
- **Output:** structured JSON `{repo, sha, suspects:[{path, lines, confidence,
  reason, introducedCommit?}]}` alongside prose; feeds existing
  `create_bug_from_incident`. Schema defined in v1 (can't retrofit).
- **Config:** `CODE_CACHE_DIR` (~/.sre-agent/repos), `CODE_CACHE_MAX_BYTES`,
  `CODE_GIT_TIMEOUT_MS`, `CODE_MAX_FILE_BYTES`, `CODE_MAX_MATCHES`,
  `CODE_ALLOWED_GIT_HOSTS`, `CODE_SHOW_AUTHORS`, `CODE_ANALYSIS_ENABLED`.
- **Locked v1 decisions (honored):** explicit repo URL (no service→repo map);
  reuse machine git creds; agentic grep/blame over code-RAG; read-only report.
- **Cheapest validation gate (optional, pre-heavy-build):** offline retrospective
  replay of 20–30 resolved incidents with known root-cause commits; score
  window-ranked vs blame-ranked top-k hit rate.
- **Acceptance:** the security must-fixes have regression tests (option injection,
  transport ban, host allowlist, path confinement); localization is one registry
  group serving CLI + MCP + web; structured report validates against schema.

## 5. Deferred to v2
service→repo auto-resolution (land `CODE_ALLOWED_GIT_HOSTS` + JSON schema now so
it's a config add); cross-incident knowledge graph / persistent code index;
pickaxe `git log -S/-G`; code-embedding RAG; learned service→repo map from the
suspect-report feedback flywheel; hosted multi-tenant web deployment; vault.

## 6. Risks
- **zod v3/v4** may force the registry schema type to live carefully at the
  boundary — resolve in P0 before P1 depends on it.
- **P1 is the largest refactor** — CI (P0) must land first to catch regressions.
- **Native/ONNX cross-platform** — CI matrix is the only proof; treat P0 CI as a
  gate on everything.
- **Localization security** — the dangerous input is the ticket, not the user;
  every git arg is downstream of attacker-writable incident text.
