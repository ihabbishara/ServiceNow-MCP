# SRE Ops MCP Server — Developer Guide

How to build, configure, connect, and use this MCP server. For a one-page setup summary see `README.md`; this document is the full developer reference.

---

## 1. What this is

An [MCP](https://modelcontextprotocol.io) server that exposes **ServiceNow** incident/change operations and **Azure DevOps** work-item operations to AI assistants (GitHub Copilot CLI, Claude Code/Desktop, VS Code Copilot). It speaks MCP over **stdio** — the client launches it as a subprocess and talks to it on stdin/stdout.

It surfaces three kinds of capability:

| MCP concept | Used for | Count |
|---|---|---|
| **Tools** | Actions the model invokes (search incidents, create a bug, …) | 11 |
| **Resources** | Read-only context the model/user can attach (an incident as markdown, a dashboard) | 5 |
| **Prompts** | Pre-built workflow templates (triage, handover, …) | 4 |

It is **standalone** — no external service layer, no database. State lives entirely in ServiceNow and Azure DevOps; this server is a stateless translator.

---

## 2. Architecture

```
MCP client (Copilot / Claude)
        │  stdio (JSON-RPC)
        ▼
  src/index.ts        bootstrap, stdio transport
  src/server.ts       registers tools / resources / prompts
  src/runtime.ts      builds clients + services from config
        │
   ┌────┴───────────────┐
   ▼                    ▼
 services/            clients/
  slaRisk              servicenow.ts   (Table API, Basic auth, fetch)
  staleTickets         ado.ts          (WIQL + work-item create, PAT)
  correlation
  incidents (facade)
  report
        ▲
        │
  types.ts   config.ts (zod-validated env)
```

The MCP surface (`src/tools/`, `src/resources/`, `src/prompts/`) only calls the **service layer** via the `McpRuntime` object. It never touches HTTP directly. Add behavior in the service layer; keep handlers thin.

---

## 3. Prerequisites

- **Node.js 18+** (uses the built-in global `fetch`).
- A **ServiceNow** instance + a user with read access to `incident` and `change_request` tables (Basic auth).
- *(optional)* An **Azure DevOps** org/project + a **PAT** with Work Items (read, write & manage) scope, if you want the ADO tools.

---

## 4. Build & run

```bash
cd MCP
npm install
npm run build      # tsc → dist/
npm test           # vitest, 47 tests
```

Scripts (`package.json`):

| Script | Does |
|---|---|
| `npm run build` | `tsc` → `dist/index.js` |
| `npm start` | `node dist/index.js` (needs env vars set) |
| `npm test` | `vitest run` |
| `npm run dev` | run from source via `ts-node` |

The server **fails fast**: started without the required env vars it prints each missing variable to stderr and exits non-zero. That is the expected way to validate your configuration:

```bash
node dist/index.js
# [sre-ops-mcp] Fatal error: Error: Invalid configuration:
#   SERVICENOW_BASE_URL: SERVICENOW_BASE_URL is required
#   ...
```

> The server reads MCP protocol on **stdin** and writes protocol on **stdout**. All logs go to **stderr** — never write to stdout from handler code or you corrupt the protocol stream.

---

## 5. Configuration

All configuration is environment variables, set in the `env` block of your MCP client config.

| Variable | Required | Default | Description |
|---|---|---|---|
| `SERVICENOW_BASE_URL` | yes | — | e.g. `https://yourcompany.service-now.com` |
| `SERVICENOW_USERNAME` | yes | — | Basic auth user |
| `SERVICENOW_PASSWORD` | yes | — | Basic auth password |
| `ADO_ENABLED` | no | `false` | Enable Azure DevOps tools |
| `ADO_ORG_URL` | if ADO enabled | — | e.g. `https://dev.azure.com/yourorg` |
| `ADO_PROJECT` | if ADO enabled | — | ADO project name |
| `ADO_PAT` | if ADO enabled | — | Personal Access Token (Work Items r/w) |
| `ADO_AREA_PATH` | no | project name | Default area path for created bugs |
| `ADO_ITERATION_PATH` | no | project name | Default iteration path for created bugs |
| `ADO_ASSIGNED_TEAM` | no | — | Default team for created bugs |
| `ADO_CREATE_BUG_ENABLED` | no | `true` | Feature flag for `create_bug_from_incident` |
| `STALE_P1_MIN` / `_P2_` / `_P3_` / `_P4_` | no | 30 / 120 / 1440 / 4320 | Stale thresholds (minutes) |
| `CORRELATION_HOURS_BEFORE` / `_AFTER` | no | 24 / 4 | Change-correlation window around incident open time |

When `ADO_ENABLED=false`, the ADO tools are inert (`search_work_items` returns empty, `create_bug_from_incident` reports it's disabled) but every ServiceNow tool works.

---

## 6. Connecting from a client

The server runs as a subprocess. Point your client's MCP config at the built `dist/index.js` with an absolute path.

**GitHub Copilot CLI** — `~/.config/github-copilot/mcp.json`:

```json
{
  "mcpServers": {
    "sre-ops": {
      "command": "node",
      "args": ["/path/to/ServiceNow-MCP/MCP/dist/index.js"],
      "env": {
        "SERVICENOW_BASE_URL": "https://yourcompany.service-now.com",
        "SERVICENOW_USERNAME": "svc.user",
        "SERVICENOW_PASSWORD": "••••••",
        "ADO_ENABLED": "true",
        "ADO_ORG_URL": "https://dev.azure.com/yourorg",
        "ADO_PROJECT": "Platform",
        "ADO_PAT": "••••••"
      }
    }
  }
}
```

**Claude Code** — register from the CLI:

```bash
claude mcp add sre-ops -- node /absolute/path/to/MCP/dist/index.js
# then set the env vars in the generated config, or use `claude mcp add ... -e KEY=VALUE`
```

**Claude Desktop / VS Code** — same shape inside their respective `mcpServers` config blocks (`claude_desktop_config.json` / `.vscode/mcp.json`).

After editing config, **restart the client** so it relaunches the subprocess. Keep secrets in the client config (or a secret manager the client supports) — do not commit them.

---

## 7. Tool reference

You normally invoke these by asking the assistant in natural language; it picks the tool and fills parameters. Parameters below are what the model fills in.

### ServiceNow — incidents

**`search_incidents`** — find incidents by filter.
`state_not`, `priority` (`"1"`–`"4"`), `assignment_group`, `assigned_to`, `short_description_contains`, `unassigned_only` (bool), `limit` (default 50, max 200).
> "Show me open P1 incidents for the Platform SRE team."

**`get_incident`** — full detail of one incident. `number` (e.g. `INC0012345`).
> "Get INC0012345."

**`summarize_incident`** — incident **plus** correlated changes **plus** linked ADO work items. Best for triage/handover.
`number`.
> "Summarize INC0012345 with related changes."

### ServiceNow — changes

**`search_changes`** — find change records. `state_not`*, `assignment_group`, `configuration_item`, `started_after` (ISO 8601), `started_before` (ISO 8601), `risk` (`High`/`Medium`/`Low`), `limit` (default 50).
> "What high-risk changes started in the last 24 hours?"
> *\* `state_not` here expects a **numeric** `change_request` state code, unlike `search_incidents` which accepts state names. See Known Limitations.*

**`get_change`** — full detail of one change. `number` (e.g. `CHG0005432`).

**`correlate_changes`** — find changes that may have caused an incident (matches CI, business service, assignment group, time window; scored). `incident_number`, `window_hours_before`, `window_hours_after` (override the configured `CORRELATION_HOURS_*` window; either bound may be omitted).
> "What changes might have caused INC0012345?"

### Analysis

**`find_sla_risks`** — open incidents near SLA breach (Critical <10% time left, High <25%, Medium <50%). `assignment_group`, `priorities` (array of `"1"`…`"4"`), `risk_level` (`Critical`/`High`/`Medium`).
> "What's at risk of breaching SLA right now?"

**`find_stale_tickets`** — open incidents not updated within the priority threshold (defaults P1 30m / P2 2h / P3 24h / P4 72h). `assignment_group`, `priorities`.
> "Which P1/P2 tickets are going stale?"

**`generate_ops_summary`** — daily operations report (open counts by priority, SLA risks, stale tickets, major incidents, failed/high-risk changes, upcoming changes, recommended actions). `date` (ISO 8601 reference day, default today), `assignment_group` (scope to one team).
> "Give me today's ops summary for the Platform SRE team."

### Azure DevOps *(only when `ADO_ENABLED=true`)*

**`search_work_items`** — search ADO by text/type/state. `query_text` (required), `work_item_type` (`Bug`/`Task`/`User Story`/`Issue`), `state`.
> "Find ADO bugs mentioning INC0012345."

**`create_bug_from_incident`** — create an ADO bug from an incident (title, repro from incident description, standard acceptance criteria, tags). `incident_number` (required), `title_override`, `additional_tags` (array), `area_path`, `iteration_path`.
> "Create a bug for INC0012345."
> Gated by `ADO_CREATE_BUG_ENABLED`. This **writes** to ADO — confirm before invoking in automation.

---

## 8. Resources

Resources are read-only context a user attaches in the client UI. The parameterized URIs are registered as MCP resource templates; substitute a real number/name (URL-encode names with spaces, e.g. `team://Platform%20SRE/incidents`).

| URI | Renders |
|---|---|
| `sla-dashboard://current` | SLA risk dashboard (markdown) |
| `stale-dashboard://current` | Stale-ticket dashboard (markdown) |
| `incident://{number}` | One incident as markdown (e.g. `incident://INC0012345`) |
| `change://{number}` | One change as markdown (e.g. `change://CHG0005432`) |
| `team://{name}/incidents` | A team's open incidents + SLA/stale rollup |

---

## 9. Prompts

Pre-built workflow templates that appear in the client's prompt picker. Each gathers context with the tools above and guides the model through a structured task.

| Prompt | Args | Purpose |
|---|---|---|
| `incident_triage` | `incident_number` | Impact assessment → root-cause hypothesis → immediate actions → next steps |
| `shift_handover` | `team_name`, `hours_back` | Active incidents, SLA risks, stale tickets, recent changes, handover notes |
| `change_review` | `change_number` | Risk / implementation / backout / dependency review with a recommendation |
| `incident_postmortem` | `incident_number` | Timeline, root cause, what-went-well/poorly, action items |

---

## 10. ServiceNow & ADO specifics

- **Auth:** ServiceNow uses HTTP Basic (`Authorization: Basic base64(user:pass)`); ADO uses Basic with an empty username and the PAT (`base64(":" + pat)`). Credentials only ever travel in headers, never in URLs or logs.
- **Field assumptions:** the ServiceNow client requests `sysparm_display_value=all` and reads machine values for priority/sys_id/dates and display values for reference fields (assignment group, CI, …). "Open" incidents are `state NOT IN 6,7,8` (Resolved/Closed/Canceled). If your instance customizes state codes or omits `sla_due`, adjust the two constants at the top of `src/clients/servicenow.ts` — `INCIDENT_FIELDS` / `OPEN_INCIDENT_QUERY` — and the `STATE_CODES` map.
- **Work notes / comments** come from the journal fields as a single concatenated blob (full per-entry history would require `sys_journal_field`).
- **Injection safety:** free-text filter values are stripped of the ServiceNow `^` query separator (`snSafe`) and WIQL strings double single quotes (`escapeWiql`).

---

## 11. Development workflow

Layout:

```
src/
  index.ts, server.ts, runtime.ts      bootstrap + wiring
  config.ts, types.ts                  config + domain types
  clients/{servicenow,ado}.ts          HTTP clients (fetch)
  services/{slaRisk,staleTickets,      domain logic (pure where possible)
            correlation,incidents,report}.ts
  tools/{incidents,changes,analysis,ado}.ts   MCP tool handlers
  resources/{incidents,changes,dashboards}.ts MCP resources
  prompts/index.ts                     MCP prompts
tests/                                 vitest (mirrors src/)
```

**Tests** stub `globalThis.fetch` (client tests) or hand-roll fakes (service tests) — no live instance needed. Run `npm test`.

**Adding a tool:**
1. If it needs new data, add a method to the relevant client/service (with tests).
2. Register the tool in the matching `src/tools/*.ts` with a `zod` input schema and a `try/catch` that returns `{ content: [...], isError: true }` on failure.
3. The handler reads from `runtime` — don't call HTTP directly.
4. Keep the tool description honest: it's the only thing the model sees to decide when and how to call it.

**TDD:** write the failing test, see it fail, implement, see it pass, commit. The existing suite is the model to follow.

---

## 12. Troubleshooting

| Symptom | Likely cause |
|---|---|
| Server exits immediately, "Invalid configuration" | Missing required env var — read the named vars in the stderr message. |
| Tools don't appear in the client | Config path wrong, or `args` path to `dist/index.js` not absolute; rebuild (`npm run build`) and restart the client. |
| ServiceNow calls fail with 401 | Bad credentials or user lacks table read. Verify: `curl -u user:pass "$SERVICENOW_BASE_URL/api/now/table/incident?sysparm_limit=1"`. |
| ADO tools say "disabled" | `ADO_ENABLED` not `true`, or the ADO vars are missing (the server fails fast on that). |
| `search_changes` returns nothing for a state name | `state_not` needs a numeric change state code here (unlike `search_incidents`). |
| `search_work_items` says ADO is disabled | Set `ADO_ENABLED=true` and the ADO connection vars. |

---

## 13. Known limitations

Remaining behaviors a developer should know:

- **Incident queries cap at 200 rows.** `find_sla_risks`, `find_stale_tickets`, the dashboards, and the ops report fetch at most 200 open incidents per assignment group; teams with more are silently truncated. Pagination is not yet implemented.
- **`search_changes` `state_not` takes a numeric change state code**, not a state name (ServiceNow change states are instance-specific; `search_incidents` maps common state names but changes do not).
- **Work notes / comments** are returned by ServiceNow as a single concatenated history blob, not discrete timestamped entries (true per-entry history would require querying `sys_journal_field`).

A full code review with `file:line` references accompanies this document; the issues it raised have been fixed except the items above.
