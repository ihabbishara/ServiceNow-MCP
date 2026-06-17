# SRE Agent — Copilot SDK Chatbot (Design Spec)

**Date:** 2026-06-17
**Status:** Approved design, ready for implementation plan
**Author:** Brainstormed with Claude

---

## 1. Problem

The org **blocked MCP servers in GitHub Copilot**, killing the delivery mechanism for our existing
`sre-ops-mcp-server` (ServiceNow + Azure DevOps SRE tooling). We need to keep using the exact same
functionality, repackaged as a **standalone chatbot/app** whose LLM connectivity comes from the
**GitHub Copilot seat** (Copilot CLI is confirmed working in this org), without routing through MCP.

## 2. Research findings that shaped this design (verified 2026-06-17)

- **Legacy GitHub-App Copilot Extensions are sunset** (fully disabled 2025-11-10). Not an option.
- **The Aider-style "Copilot token → `api.githubcopilot.com`" hack** works but **violates GitHub AUP**
  (proxy/automated usage); permanent-ban risk. Rejected.
- **GitHub Models** inference API is **being retired** (no new customers since 2026-06-16). Rejected.
- **The official GitHub Copilot SDK** (`@github/copilot-sdk`) went **GA 2026-06-02**, semver-stable
  (`1.0.1`), MIT, Node `^20.19 || >=22.12`. It wraps the Copilot CLI agent loop over JSON-RPC and
  bundles the `@github/copilot` runtime (no separate CLI install). **Selected.**
- **Custom tools (`defineTool`) are a different mechanism from MCP servers** in the SDK (separate
  session fields: `tools` vs `mcpServers`). An org MCP block does **not** disable custom tools. This is
  what makes the whole approach viable.
- **The org also bans Azure DevOps Personal Access Tokens (PATs)** → the existing PAT-based REST
  `ado.ts` is unusable here. The sanctioned path is the **`az boards` CLI** (the `azure-devops` Azure
  CLI extension), authenticated via **`az login` (Microsoft Entra), no PAT**. MS Learn confirms verbatim:
  *"If you already signed in interactively with `az login`, you don't need to provide a PAT."* Reads use
  `az boards work-item show` (single) and `az boards query --wiql ...` (returns fully-hydrated fields,
  not just ids); writes use `az boards work-item create`. Same auth covers both. Cloud-only (not ADO
  Server); guest/B2B identities are forced back to PAT; unattended service-principal/managed-identity
  auth is not cleanly documented and must be validated live.

Sources: github/copilot-sdk repo (Node README, docs/auth, docs/features/mcp, samples/manual-tool-resume.ts),
github.blog GA changelog 2026-06-02; MS Learn azure/devops/cli (get-started, log-in-via-pat, boards/work-item,
wiql-syntax) + azure-devops-cli-extension source (`work_item.py`).

## 3. Decisions (locked)

| Decision | Choice |
|---|---|
| LLM runtime | Official **GitHub Copilot SDK** (`@github/copilot-sdk@1.0.x`, Node) |
| Auth (default) | **Copilot seat** — `new CopilotClient()` auto-detects the logged-in `copilot` CLI / `COPILOT_GITHUB_TOKEN` |
| Auth (fallback) | **BYOK** (Azure OpenAI / Anthropic) via per-session `provider` config — a config branch, same code |
| Surface (v1) | **Standalone CLI chatbot** over a reusable, front-end-agnostic chat engine |
| Surface (later) | Slack/Teams/web as thin adapters over the same engine |
| Scope (v1) | **Full parity**: all 11 tools + 4 workflow commands; ADO bug-create behind a confirm gate |
| Code structure | **npm workspaces monorepo** — extract shared `core`, two adapters (`mcp-server`, `sre-agent`) |
| ADO access | **`az boards` CLI** via `az login` (no PAT). `ADO_AUTH_MODE=azcli` (default here) \| `pat` (kept for portability). `AzureDevOpsClient` is an interface with two impls. |
| ADO reads (new) | `get_work_item` (show by id) + extend `search_work_items` to query stories/tasks/bugs by type/state/area/assignee via WIQL |

## 4. Architecture

### 4.1 Core insight
The existing `clients/` + `services/` are the brains; the MCP `tools/resources/prompts` are thin
wrappers over a `runtime` object. This is therefore **a second adapter over the same core, not a
rewrite**. Each of the 11 MCP tools maps 1:1 to a `defineTool(...)` custom tool. ServiceNow/ADO logic
is untouched.

### 4.2 Target structure (npm workspaces)

```
ServiceNowMCP/                      (workspaces root: { "workspaces": ["packages/*"] })
  packages/
    core/                          MOVED from MCP/src
      src/ clients/ services/ config.ts types.ts runtime.ts
      tests/                       the existing 47 tests move here, keep guarding core
      package.json  (name: @sre/core)
    mcp-server/                    existing MCP adapter, imports @sre/core
      src/ tools/ resources/ prompts/ server.ts index.ts
      package.json  (name: @sre/mcp-server, bin → dist/index.js)
    sre-agent/                     NEW Copilot-SDK chatbot, imports @sre/core
      src/
        tools/        11 defineTool wrappers over core services (reuse existing zod schemas + descriptions)
        engine/       CopilotClient lifecycle, session, streaming, permission gate (front-end-agnostic)
        workflows/    4 commands (triage/handover/change_review/postmortem) = ported prompt templates
        cli/          REPL front-end (v1 surface)
        config.ts     extends core config: LLM mode/model/provider + confirm policy
        index.ts      CLI entry (bin)
      package.json  (name: @sre/sre-agent, bin: sre-agent → dist/cli)
```

Keeping `mcp-server` alive is a free hedge: it works the instant the org un-blocks MCP.

### 4.3 Runtime / auth flow

- Default: `new CopilotClient()` → `await client.start()` → seat auth auto-detected (logged-in Copilot CLI
  or `COPILOT_GITHUB_TOKEN`/`GH_TOKEN`/`GITHUB_TOKEN`). Burns Copilot premium requests.
- Fallback (`LLM_MODE=byok`): same client, `createSession({ model, provider })` where `provider` is
  `{ type: "azure"|"anthropic"|"openai", baseUrl, apiKey, ... }`. BYOK **requires explicit `model`**.
  Azure footgun: native `*.openai.azure.com` → `type: "azure"` (host only); Foundry `/openai/v1/`
  endpoint → `type: "openai"`.
- Bundled `@github/copilot` runtime → no separate CLI install for deployment. Node 20.19+/22.12+.

## 5. Components (`sre-agent`)

### 5.1 Tool registry (`src/tools/`)
One `defineTool(name, { description, parameters, handler })` per existing MCP tool:

| Tool | Read/Write | `skipPermission` | Handler calls |
|---|---|---|---|
| search_incidents | R | yes | serviceNowClient.listIncidentsWithFilters |
| get_incident | R | yes | serviceNowClient.getIncidentByNumber |
| summarize_incident | R | yes | incidentService.summarizeIncident |
| search_changes | R | yes | serviceNowClient.listChangesWithFilters |
| get_change | R | yes | serviceNowClient.getChangeByNumber |
| correlate_changes | R | yes | incidentService.findRelatedChanges |
| find_sla_risks | R | yes | incidentService.listSlaRisks |
| find_stale_tickets | R | yes | incidentService.listStaleIncidents |
| generate_ops_summary | R | yes | reportService.generateDailyOpsReport |
| search_work_items | R | yes | azureDevOpsClient.searchWorkItems (now WIQL via az boards; `query_text` optional; adds type/state/area/assignee filters) |
| **get_work_item** (new) | R | yes | azureDevOpsClient.getWorkItem (`az boards work-item show --id`) |
| **create_bug_from_incident** | **W** | **no (gated)** | incidentService.summarizeIncident + azureDevOpsClient.createBug (via `az boards work-item create` when `ADO_AUTH_MODE=azcli`) |

This brings the agent to **12 tools** (was 11). The `search_work_items` schema gains optional
`work_item_type` (already present), `state` (already present), and new `area_path`, `assigned_to`
(accepts `@Me`) filters; `query_text` becomes optional so you can list stories/tasks without a title term.

- Reuse the existing zod input schemas and the model-tuned tool descriptions **verbatim** — descriptions
  are the only thing the model sees to decide when/how to call.
- Handlers call `runtime.<service>.<method>()` and return the same JSON the MCP handlers return.
- Each handler wraps in try/catch → returns `{ error: string }` so a failure is recoverable by the model,
  never crashes the session.

### 5.2 Chat engine (`src/engine/`)
- Owns `CopilotClient`: `start()`, `createSession({ model, tools, onPermissionRequest, streaming: true })`,
  `disconnect()`, `stop()`.
- One persistent multi-turn session (infinite-session compaction is on by default → long SRE chats
  won't blow context).
- Streams: subscribe `assistant.message_delta` (token stream), `tool.execution_start/complete` (activity),
  resolve a turn on `session.idle`. `abort()` on Ctrl-C.
- Front-end-agnostic: exposes `send(prompt) → stream` and a `confirm` injection point; CLI/Slack/web all
  consume this.
- Auth branch (seat vs BYOK) lives here, driven by config.

### 5.3 Permission gate (`src/engine/permissions.ts`)
- `onPermissionRequest(request)`: if `request.kind === "custom-tool" && request.toolName ===
  "create_bug_from_incident"` → invoke the front-end `confirm(summary)` callback → return
  `{ kind: "approve-once" }` or `{ kind: "reject", feedback: "User declined the write." }`.
- Everything else: read-only tools carry `skipPermission: true`, so only the write reaches the gate.
- Honors existing `ADO_CREATE_BUG_ENABLED` feature flag **and** a new `CONFIRM_WRITES` policy
  (default `true`).

### 5.4 Workflows (`src/workflows/`)
The 4 existing prompt templates become first-class commands, text ported verbatim from
`prompts/index.ts`:

| Command | Args | Seeds session with |
|---|---|---|
| `/triage <INC>` | incident_number | incident_triage prompt |
| `/handover <team> [hours]` | team_name, hours_back | shift_handover prompt |
| `/review <CHG>` | change_number | change_review prompt |
| `/postmortem <INC>` | incident_number | incident_postmortem prompt |

No new logic — each seeds the prompt; the model then drives the tools.

### 5.5 CLI front-end (`src/cli/`)
- readline REPL: prompt, slash-command parsing (`/triage`, `/handover`, `/review`, `/postmortem`,
  `/help`, `/exit`), streamed output, tool-activity lines, Ctrl-C aborts the in-flight turn.
- System prompt establishes the SRE-assistant persona and notes the available tools.
- Supplies the terminal y/N `confirm` callback to the engine for the write gate.

### 5.6 Config (`src/config.ts`)
Extends core zod config with:

| Var | Default | Purpose |
|---|---|---|
| `LLM_MODE` | `seat` | `seat` \| `byok` |
| `LLM_MODEL` | `gpt-5` | model id |
| `LLM_PROVIDER` | — | byok: `azure`\|`anthropic`\|`openai` |
| `LLM_BASE_URL` | — | byok endpoint |
| `LLM_API_KEY` | — | byok key |
| `AZURE_API_VERSION` | `2024-10-21` | byok azure only |
| `CONFIRM_WRITES` | `true` | gate ADO bug-create |
| `ADO_AUTH_MODE` | `azcli` | `azcli` (az boards, no PAT) \| `pat` (legacy REST) |
| `AZ_PATH` | `az` | path to the `az` binary (override for non-standard installs) |

Plus all existing ServiceNow/ADO vars. When `ADO_AUTH_MODE=azcli`, `ADO_ORG_URL` + `ADO_PROJECT` are
still required (passed as `--org`/`--project`) but **`ADO_PAT` is not used**; when `pat`, the existing
PAT vars apply. Fail-fast (zod, stderr) as today. Validation: `byok` requires `LLM_MODEL` + provider
block; `azcli` requires `ADO_ORG_URL` + `ADO_PROJECT` (and a working `az login` session at runtime,
checked by preflight — see §5.7).

### 5.7 ADO access via `az boards` (no-PAT) — lives in `packages/core`

The org bans ADO PATs, so the existing PAT REST client cannot run here. Refactor the ADO layer so the
auth mechanism is swappable:

- **`AzureDevOpsClient` becomes an interface** (existing methods: `searchWorkItems`, `createBug`; new:
  `getWorkItem`). Two implementations, selected by `ADO_AUTH_MODE`:
  - `AdoPatClient` — the current REST+PAT class, renamed. Kept for portability / non-restricted orgs.
  - **`AzBoardsClient`** (new, default) — shells out to the Azure CLI; no PAT.
- **`AzRunner` helper** (`core/src/clients/az.ts`): wraps `child_process.execFile("az", args)`. Always
  appends `--output json --only-show-errors` and explicit `--org <ADO_ORG_URL>` (+ `--project
  <ADO_PROJECT>` where the subcommand accepts it; `work-item show` is id-global and takes only `--org`).
  Resolves the parsed JSON on **exit code 0**; on non-zero, throws with stderr. Never treat non-empty
  stderr as failure (az warns on stderr even on success). Binary path from `AZ_PATH`.
- **Reads:**
  - `getWorkItem(id)` → `az boards work-item show --id <id> --expand fields` → map the `fields` dict.
  - `searchWorkItems(filters)` → build a **WIQL** string and run `az boards query --wiql "<wiql>"`. The
    query returns **fully-hydrated** items (no follow-up `show`). WIQL is assembled from filters:
    `[System.WorkItemType]=`, `[System.State]=`, `[System.AreaPath] UNDER`, `[System.AssignedTo]=` (with
    `@Me` support), and `[System.Title] CONTAINS` when `query_text` is given. Always `SELECT` the fields
    we map + `ORDER BY [System.ChangedDate] DESC`.
- **Write (gated):** `createBug(payload)` → `az boards work-item create --type Bug --title <t>
  --area <a> --iteration <i> --fields "<ref=value> ..."` (note: create/update use **space-separated
  `field=value`**, unlike `show`'s comma-separated `--fields` name list). Same `az login` auth.
- **Field mapping — VERIFIED against a live `az boards work-item show --id 8533637` (org INGCDaaS,
  project IngOne, 2026-06-17).** The response is `{ id, rev, url, fields: {…}, relations: [...],
  multilineFieldsFormat: {…} }`. Read `fields` with bracket access (dotted keys). Map to a **slim
  `WorkItem`** — do NOT return the raw blob (avatars, `_links`, `descriptor`s, `WEF_*` Kanban fields,
  HTML bodies, and `relations[]` would burn the model's context):
  - `System.Id`→id, `System.Title`→title, `System.WorkItemType`→type (extend `WorkItem` with this),
    `System.State`→state, `System.AreaPath`→areaPath, `System.IterationPath`→iterationPath,
    `Microsoft.VSTS.Common.Priority`→priority (number), `Microsoft.VSTS.Scheduling.StoryPoints`→storyPoints,
    `System.Parent`→parentId, `url`→url.
  - `System.AssignedTo` is a **fat object** → `.uniqueName ?? .displayName` (guard: the whole field may be
    **absent** when unassigned).
  - `System.Tags` may be **absent**; when present it's a `"; "`-joined string → `split(/;\s*/)`.
  - `System.Description` / `Microsoft.VSTS.Common.AcceptanceCriteria` / `System.History` are **HTML**
    (per `multilineFieldsFormat`); if surfaced, strip tags to plain text before returning.
  - **`System.AreaPath` uses `\` separators** (JSON-escaped as `\\`, e.g. `IngOne\P33421-PSSSRE`); preserve
    the single backslash when building WIQL `UNDER 'IngOne\Team'` filters.
  - `getWorkItem` uses `--expand fields` to skip the heavy `relations[]`; only request `--expand relations`
    if a future tool needs parent/child or PR/commit links.
- **WIQL injection safety:** the existing `escapeWiql` (doubles `'`) is reused for all interpolated
  filter values; numeric ids are validated as integers before shelling out.
- **Preflight / doctor:** on `azcli` startup (and a `/doctor` CLI command), verify `az` is on PATH, the
  `azure-devops` extension is present (`az extension show -n azure-devops`, or rely on first-run
  auto-install), and a session exists (`az account show`). Fail fast with a clear remediation message
  (*"run `az login`"*) instead of an opaque tool error mid-chat.
- **Performance:** each `az` call is a cold process spawn (~0.3–2s). Prefer a single `az boards query`
  (up to 1000 hydrated items) over N× `work-item show`. Keep concurrency modest (ADO REST throttling).

**Known constraints (documented, surface in README):** `az boards` is **Azure DevOps Services only**
(not Server); **guest/B2B identities** are forced back to PAT (no-PAT won't work for them);
**unattended SP/managed-identity** auth via `az login` is not cleanly documented — fine for the
interactive CLI (human did `az login`), but **must be validated** before any cron/bot/M5 deployment.

## 6. Data flow

```
User → CLI → engine.send(prompt) → Copilot session → model
   → custom tool handler → core service → ServiceNow (HTTP) | ADO (az boards subprocess) → result → model
   → streamed answer → CLI render
Write path: model calls create_bug_from_incident → onPermissionRequest → CLI y/N
   → approve-once (runs `az boards work-item create`) | reject(feedback) (model told it was declined)
```

## 7. Error handling
- Tool handlers try/catch → `{ error }`; model recovers, session survives.
- `summarize_incident` already swallows ADO failures (graceful degradation) — preserved.
- Engine: transport error → surface + offer reconnect. BYOK static bearer expiry → recreate session.
- 200-row incident cap inherited from core → surface a note when a result likely hit it (existing known
  limitation; pagination is a separate backlog item).

## 8. Testing
- **Core:** existing 47 tests move to `packages/core`, unchanged — they guard the refactor.
- **sre-agent tools:** unit-test each `defineTool` handler against a fake runtime (same fake pattern as
  existing service tests): asserts correct service call + output shape + error wrapping.
- **Permission gate:** unit-test write → confirm (approve path runs tool; reject path returns feedback,
  tool not called).
- **Engine:** integration test with a stubbed `CopilotClient` — asserts tools registered, prompt sent,
  `session.idle` resolves, streaming deltas forwarded.
- **`AzBoardsClient`:** unit-test against a **fake `AzRunner`** (mock `execFile`): assert the exact `az`
  argv built per filter set (WIQL string, `--org/--project`, `--output json --only-show-errors`),
  correct parsing of the `fields` dict (assignee object, absent assignee, tags split, dotted keys),
  exit-code handling (0 → parse; non-zero → throw with stderr; non-empty stderr on success → not an
  error). Pure string/JSON logic, no live `az` needed.
- **Seat e2e:** manual smoke against a live Copilot seat (cannot be unit-tested).
- **ADO az e2e:** manual smoke against a live `az login` session (read a known work-item id, run a query).
- **CLI:** thin; manual smoke + minimal parsing unit tests.

## 9. Milestones
- **M0** — workspace extraction: `core` + `mcp-server` packages, all 47 tests green, MCP server still builds/runs.
- **M1** — `sre-agent` skeleton: `CopilotClient` hello-world on the seat, one tool wired, REPL echoes a streamed answer.
- **M2a** — **`AzBoardsClient` + `AzRunner` in core** behind the `AzureDevOpsClient` interface; `ADO_AUTH_MODE`
  switch; `getWorkItem` + WIQL `searchWorkItems`; preflight/doctor; unit tests green. (The new ADO read ask.)
- **M2b** — all 12 tools wired into `sre-agent` (incl. `get_work_item`, extended `search_work_items`) +
  permission gate on the write (`create_bug_from_incident` via `az boards work-item create`).
- **M3** — 4 workflow commands.
- **M4** — BYOK fallback + config hardening + README/USAGE for the agent.
- **M5** (later) — Slack adapter over the same engine.

## 10. Risks & mitigations
- **LLM default = `seat` (DECIDED 2026-06-17)** — Copilot CLI confirmed working. If the org later blocks
  the Copilot CLI policy, flip `LLM_MODE=byok` + Azure OpenAI creds in the same SDK (config-only, no code
  change). No org sign-off needed to start; revisit only if seat access is revoked.
- **`az login` no-PAT auth** — **VALIDATED 2026-06-17** for this org/identity (org INGCDaaS, project
  IngOne, interactive `az login` → `az boards work-item show` returns full JSON). Residual: guest/B2B
  identities and older extension versions can still fail for *other* operators → keep a clear preflight
  error pointing to `az login`, and `ADO_AUTH_MODE=pat` as an escape hatch if PATs ever return.
- **Unattended (cron/bot) ADO auth** via SP/managed-identity is not cleanly documented → fine for the
  interactive CLI; gate any headless deployment on a live validation or an ADO service connection.
- **`az` is an external dependency** on the host (must be installed + extension + logged in) and adds
  ~0.3–2s per call → preflight check; prefer batched `az boards query` over many `show` calls.
- **Seat mode burns premium requests** (cost) → BYOK available; surface usage in docs.
- **SDK young (GA but v1.0.x)** → pin the version; avoid the `unstable` dist-tag.
- **ToS** → seat-via-official-SDK is sanctioned (unlike the token hack); `az login` + `az boards` is the
  org-sanctioned ADO path. Clean.

## 11. Explicitly out of scope (YAGNI for v1)
- Slack/Teams/web front-ends (M5+, separate specs).
- Unattended/headless ADO auth (service principal / managed identity) — interactive `az login` only for v1.
- Tree/one-hop WIQL link queries (`az boards query` supports flat queries only) and saved-query-by-GUID.
- Pagination beyond the 200-row ServiceNow cap and the 1000-item `az boards query` cap (backlog).
- Per-entry journal history (`sys_journal_field`) — inherited limitation.
- Persisting/searching conversation history beyond the SDK's built-in session store.
