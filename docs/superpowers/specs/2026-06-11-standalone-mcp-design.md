# Standalone SRE Ops MCP Server — Design

**Date:** 2026-06-11
**Status:** Approved
**Context:** The MCP server in `MCP/` was built as a subdirectory of the SREOps repo and imported its compiled service layer via `../../dist/*`. The SREOps repo is no longer available. This design makes the MCP server fully standalone, configured entirely through environment variables.

## Goals

- `npm run build` succeeds with zero external project dependencies.
- All 11 tools, 5 resources, and 4 prompts work against a real ServiceNow instance (basic auth) and a real Azure DevOps organization (PAT).
- All connection and auth settings configurable via environment variables.
- No mock clients. Tests use fixture data and stubbed `fetch`, never a live instance.

## Non-Goals

- Custom field/table mapping per instance (standard `incident` / `change_request` tables assumed).
- OAuth or API-key auth for ServiceNow (basic auth only; client design leaves room to add later).
- Per-deployment tool enable/disable flags (ADO on/off is the only toggle).

## Decisions Made

| Question | Decision |
|---|---|
| ServiceNow access | Real work instance, basic auth |
| Azure DevOps | Kept, real access via PAT, toggleable with `ADO_ENABLED` |
| Configurability scope | Connection + auth via env vars; thresholds env-overridable with defaults |
| Mock mode | Removed entirely |
| Tool scope | All 11 tools, 5 resources, 4 prompts |
| Approach | Rebuild service layer inside `MCP/src/`; keep existing consumer code untouched |

## Architecture

Existing consumer code (tools/resources/prompts) is written against interfaces exposed by `runtime.ts` (`McpRuntime`). The rebuild replaces what is behind those interfaces; method names and return shapes are preserved exactly so consumers compile unchanged.

```
tools/ resources/ prompts/   (existing, untouched except 2 import lines)
        │
        ▼
runtime.ts        (rewritten: builds clients + services from config)
        │
   ┌────┴─────────────┐
   ▼                  ▼
services/          clients/
slaRisk            servicenow.ts  (Table API, fetch, basic auth)
staleTickets       ado.ts         (WIQL + work item create, fetch, PAT)
correlation
incidents (facade)
report
   ▲
   │
types.ts   config.ts (zod-validated env)
```

### New files

| File | Purpose | Est. size |
|---|---|---|
| `src/types.ts` | `Incident`, `ChangeRecord`, `RelatedChange`, `SlaRiskItem`, `StaleTicketItem`, `WorkItem`, `DailyOpsReport` | ~120 lines |
| `src/config.ts` | Env var loading + zod validation, fail-fast | ~90 lines |
| `src/clients/servicenow.ts` | `ServiceNowClient` | ~200 lines |
| `src/clients/ado.ts` | `AzureDevOpsClient` | ~150 lines |
| `src/services/slaRisk.ts` | SLA risk computation | ~60 lines |
| `src/services/staleTickets.ts` | Staleness detection | ~50 lines |
| `src/services/correlation.ts` | Change↔incident correlation scoring | ~90 lines |
| `src/services/incidents.ts` | `IncidentService` facade | ~80 lines |
| `src/services/report.ts` | `ReportService` | ~80 lines |
| `src/runtime.ts` | Rewritten with local imports, no mock branching | ~50 lines |

### Changed files (one line each)

- `src/resources/incidents.ts:3` — import `Incident` from `../types.js`
- `src/resources/changes.ts:3` — import `ChangeRecord` from `../types.js`

## Interface Contract (extracted from existing consumers)

These signatures are fixed; consumers already call them.

```typescript
interface ServiceNowClient {
  listIncidentsWithFilters(f: { stateNot?, priority?, assignmentGroup?, assignedTo?,
    shortDescriptionContains?, limit? }): Promise<Incident[]>
  getIncidentByNumber(number: string): Promise<Incident | null>
  listIncidents(f: { onlyOpen?, assignmentGroup? }): Promise<Incident[]>
  listChangesWithFilters(f: { stateNot?, assignmentGroup?, configurationItem?,
    startedAfter?, limit? }): Promise<ChangeRecord[]>
  getChangeByNumber(number: string): Promise<ChangeRecord | null>
}

interface AzureDevOpsClient {
  searchWorkItems(f: { text, workItemType?, state? }): Promise<WorkItem[]>
  createBug(p: { title, description, areaPath?, iterationPath?, tags?,
    assignedTeam?, incidentNumber }): Promise<{ id, title }>
}

interface IncidentService {
  summarizeIncident(number): Promise<{ incident: Incident,
    relatedChanges: RelatedChange[], relatedWorkItems: WorkItem[] }>
  listSlaRisks(f: { onlyOpen?, assignmentGroup?, priorities? }): Promise<SlaRiskItem[]>
  listStaleIncidents(f: { onlyOpen?, assignmentGroup?, priorities? }): Promise<StaleTicketItem[]>
  findRelatedChanges(number): Promise<RelatedChange[]>
}

interface ReportService {
  generateDailyOpsReport(): Promise<DailyOpsReport>
  // DailyOpsReport: { generatedAt, generatedForDate, executiveSummary,
  //   openIncidentsByPriority, slaRisks, staleIncidents, majorIncidents,
  //   failedOrHighRiskChanges, upcomingChanges, recommendedActions }
}
```

`McpRuntime` keeps fields: `config`, `serviceNowClient`, `azureDevOpsClient`, `incidentService`, `reportService`, `slaRiskService`, `staleTicketService`, `correlationService`.

`config` keeps the shape consumers touch: `config.azureDevOps.enabled`, `config.azureDevOps.disabledMode` (fixed to `"noop"` when disabled — keeps `ado.ts` check working), `config.azureDevOps.defaultAreaPath` / `defaultIterationPath` / `defaultAssignedTeam`, `config.features.createAdoBug`.

## Configuration

All via environment variables (passed in the `env` block of the MCP client config, e.g. `mcp.json`). No dotenv dependency.

| Variable | Required | Default |
|---|---|---|
| `SERVICENOW_BASE_URL` | yes | — |
| `SERVICENOW_USERNAME` | yes | — |
| `SERVICENOW_PASSWORD` | yes | — |
| `ADO_ENABLED` | no | `false` |
| `ADO_ORG_URL` | when ADO enabled | — |
| `ADO_PROJECT` | when ADO enabled | — |
| `ADO_PAT` | when ADO enabled | — |
| `ADO_AREA_PATH` | no | `ADO_PROJECT` value |
| `ADO_ITERATION_PATH` | no | `ADO_PROJECT` value |
| `ADO_ASSIGNED_TEAM` | no | unset |
| `ADO_CREATE_BUG_ENABLED` | no | `true` (maps to `features.createAdoBug`) |
| `STALE_P1_MIN` / `STALE_P2_MIN` / `STALE_P3_MIN` / `STALE_P4_MIN` | no | 30 / 120 / 1440 / 4320 |
| `CORRELATION_HOURS_BEFORE` / `CORRELATION_HOURS_AFTER` | no | 24 / 4 |

Validation: zod schema in `config.ts`. Missing required vars → process exits at startup with a message naming each missing variable. `ADO_ENABLED=true` without the three ADO vars → same fail-fast.

## ServiceNow Client

- REST Table API: `GET {base}/api/now/table/incident` and `.../change_request`.
- Query built as `sysparm_query` encoded-query string (e.g. `state!=7^priority=1^assignment_group.name=Platform`).
- Always `sysparm_display_value=true` so reference fields (assignment group, assigned to, CI, business service) come back as names, matching how tools filter and render.
- `sysparm_limit` from caller (cap 200), `sysparm_fields` trimmed to mapped fields.
- "Only open" = `state NOT IN (6, 7, 8)` (Resolved, Closed, Canceled) using `stateNOT IN` encoded query; configurable later if instance uses custom states.
- One mapping function per table (`mapIncident`, `mapChange`): SN snake_case → domain camelCase. `workNotes` / `comments` come from `work_notes` / `comments` journal fields on the single-record fetch (display value returns the latest entries as text; split on journal separators, best-effort).
- Auth: `Authorization: Basic base64(user:pass)`.
- Errors: non-2xx → `Error` with method, URL path, status, and first 200 chars of body.

## Azure DevOps Client

- Search: `POST {org}/{project}/_apis/wit/wiql?api-version=7.1` with WIQL `SELECT [System.Id] FROM WorkItems WHERE [System.Title] CONTAINS '...'` plus optional type/state clauses; then batch-fetch details via `GET _apis/wit/workitems?ids=...`.
- Create: `POST {org}/{project}/_apis/wit/workitems/$Bug?api-version=7.1` with JSON-patch body (title, description as HTML, area/iteration path, tags).
- Auth: `Authorization: Basic base64(":" + PAT)`.
- When `ADO_ENABLED=false`: `searchWorkItems` returns `[]`, `createBug` throws "ADO integration is disabled" (the tool layer already converts this to a clean `isError` response; `summarize_incident` still works, just with empty work items).

## Domain Logic

Original SREOps source is gone; rules are rebuilt from the contracts stated in the tool descriptions (which are user-facing and must stay truthful).

**SLA risk** (`services/slaRisk.ts`): for incidents with `slaDue`, window = `openedAt → slaDue`; `remaining% = (slaDue - now) / window`. Levels per the `find_sla_risks` description: Critical < 10%, High < 25%, Medium < 50%. Already-breached (negative remaining) → Critical with `remainingMinutes ≤ 0`. No `slaDue` → excluded. `suggestedAction`: template per level (e.g. Critical → "Escalate immediately; SLA breach imminent").

**Staleness** (`services/staleTickets.ts`): stale when `now - updatedAt > threshold[priority]` (defaults P1=30m, P2=2h, P3=24h, P4=72h — matches `find_stale_tickets` description). Reports `staleByMinutes` (overshoot) and `thresholdMinutes`.

**Correlation** (`services/correlation.ts`): candidate changes where actual-or-planned start falls in `[openedAt - beforeHours, openedAt + afterHours]`. Additive score: same `cmdbCi` +0.5, same `businessService` +0.25, same `assignmentGroup` +0.15, start within ±2h of `openedAt` +0.1. Report matches with score ≥ 0.25, sorted descending. `correlationReason` lists matched dimensions ("Same CI; within change window").

**Incident facade** (`services/incidents.ts`): `summarizeIncident` = `getIncidentByNumber` + `findRelatedChanges` + `searchWorkItems({ text: incidentNumber })`. Incident not found → throw (tool layer reports it). `listSlaRisks` / `listStaleIncidents` fetch open incidents (optionally filtered) then apply the pure services.

**Report** (`services/report.ts`): `generateDailyOpsReport` aggregates: open incidents grouped by priority, SLA risks, stale incidents, major incidents (open P1s), failed or high-risk changes (state Failed/Cancelled or risk High, last 24h), upcoming changes (planned start within next 24h), `executiveSummary` one-paragraph text composed from the counts, `recommendedActions` from top SLA risks + stale P1/P2s.

## Error Handling

- Startup: config validation fail-fast (clear stderr message, exit 1).
- Clients: throw `Error` with context; never return partial silently.
- Tool/resource handlers: existing `try/catch → isError: true` pattern, untouched.

## Testing (vitest, already in devDependencies)

- `tests/services/*.test.ts` — pure-logic tests on fixture incidents/changes: SLA boundaries (10/25/50%), breached SLA, stale thresholds per priority, correlation scoring and threshold, report aggregation.
- `tests/clients/*.test.ts` — stub `globalThis.fetch`; assert query-string construction (encoded queries, display_value, limit cap), field mapping, auth header, error propagation on 401/500, WIQL body shape, JSON-patch body shape.
- No tests hit a live instance.

## Definition of Done

- [ ] `npm run build` succeeds in `MCP/`
- [ ] `npm test` passes
- [ ] Server starts with valid env, exits with clear message on missing env
- [ ] `search_incidents` and `get_incident` verified against the real work instance
- [ ] `create_bug_from_incident` verified against real ADO (or explicitly deferred)
- [ ] README updated: new env var table, removed SREOps references
