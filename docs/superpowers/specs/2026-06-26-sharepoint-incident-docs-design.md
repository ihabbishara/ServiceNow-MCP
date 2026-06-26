# Design — SharePoint Incident-Docs Retrieval

- **Date:** 2026-06-26
- **Status:** approved (design); implementation not started
- **Goal:** When a chat references an incident number (e.g. `INC123456`), let the agent fetch that incident's documents from a SharePoint Online document library, extract their text, and return it so the model can read and cite — alongside (not replacing) the existing ServiceNow fetch.

---

## 1. Problem & context

Incident knowledge lives in two places today:
- **ServiceNow** — the incident record (already fetched via `get_incident` / `summarize_incident`).
- **SharePoint Online** — per-incident document folders, structured as:

  ```
  INC123456 iDeal/            ← folder name = "<INC#> <project>", prefix match on INC#
    ├── Docs/                 ← target: recurse this subtree, arbitrarily deep
    │   ├── *.docx / *.xlsx / *.pptx / *.pdf
    │   └── <subfolders>/ ...
    └── IncidentNoteBook/     ← excluded (OneNote, not text-extractable the same way)
  ```

The agent has no SharePoint integration. We add a read-only path keyed by incident number.

**Constraints (org):** the tenant blocks MCP servers and ADO PATs; `az` CLI login already works and is the sanctioned auth path (the agent uses it for `az boards`). The design must add **no new PAT, secret, or broad app permission**.

---

## 2. Approach (chosen)

**Microsoft Graph API + delegated `az` CLI token + extract-text inline.**

- **Auth:** reuse the existing `AzRunner` (`clients/ado/az.ts`) to mint a delegated Graph token: `az account get-access-token --resource https://graph.microsoft.com`. Delegated → respects the calling user's SharePoint permissions; no app registration, no secret, no admin consent.
- **Locate:** the incident folder name is `<INC#> <project>`, so exact path-addressing fails. Resolve the folder id first by listing the configured base folder's children and filtering `startswith(name, INC#)` (case-insensitive), then path-address into `Docs`.
- **Walk:** recurse the `Docs` subtree using each driveItem's `folder` vs `file` facet — descend folders, collect files. Honor pagination (`@odata.nextLink`) and throttling (`429` + `Retry-After`).
- **Extract:** download each file's bytes and convert to text by format (docx, xlsx, pptx, pdf).
- **Assemble:** concatenate under a token budget; truncate (not embed) on overflow in v1.

### Approaches considered (and why rejected)
- **App-only auth (`Sites.Read.All` / `Sites.Selected`):** needs a client secret + admin consent. Org resists broad app permissions; delegated az token rides already-approved identity. → Deferred (see §10).
- **SharePoint REST `_api/search/query`:** legacy, SPO-specific. Graph is the modern, supported surface and we already have az-based Graph auth. → Rejected.
- **Embed incident docs into the RAG store, semantic top-k:** RAG's payoff is a large, stable corpus queried many times. One incident is a small, ephemeral set read once or twice per chat; embedding adds synchronous latency on the hot path (user waiting) and retrieval loss vs. full-read, and would entangle the knowledge-store schema (per-incident filtering). → Deferred as an overflow extension (see §10).

---

## 3. Architecture

New **read-only** integration, gated on `SHAREPOINT_ENABLED` (same gating style as `ADO_ENABLED` and the `knowledgeEnabled` flag). One tool, `get_incident_documents`, projected in both `packages/sre-agent/src/tools/index.ts` and the matching `packages/mcp-server/src/tools/*`.

```
chat references INC123456
  → model calls get_incident_documents({ incident: "INC123456" })
    SharePointService.getIncidentDocuments("INC123456"):
      1. GraphClient: delegated az token (cached to expiry)
      2. locate: list base-folder children → startswith("INC123456") → folder id
      3. walk: items/{id}:/Docs:/children, recurse folder facets, yield files
      4. download + extract each (bounded concurrency, 429-aware)
      5. assemble under SHAREPOINT_MAX_DOC_TOKENS; truncate overflow
    → return projected JSON
  → model reads + cites
```

---

## 4. Components

Each unit has one purpose, a defined interface, and is testable with a faked Graph (no live network). New directory `packages/core/src/clients/sharepoint/` mirroring `clients/ado/`, plus a service under `packages/core/src/services/sharepoint/`.

| Unit | Responsibility | Interface (sketch) | Depends on |
|---|---|---|---|
| `clients/sharepoint/graph.ts` `GraphClient` | Acquire + cache delegated token; GET/POST with bearer; honor `429`/`Retry-After`; follow `@odata.nextLink`; optional proxy; download item bytes | `get<T>(path)`, `getAllPages<T>(path)`, `download(driveId, itemId): Buffer` | `AzRunner`, `undici`/`fetch`, proxy config |
| `clients/sharepoint/site.ts` | Resolve `SHAREPOINT_SITE_URL` → `siteId` + default `driveId`; cache | `resolve(): { siteId, driveId }` | GraphClient, config |
| `clients/sharepoint/locate.ts` | List base-folder children, filter `startswith(name, INC#)` (case-insensitive), pick the `folder`-facet item | `findIncidentFolder(driveId, inc): { id, name } \| null` | GraphClient, config |
| `clients/sharepoint/walk.ts` | Path-address `:/Docs:/children`, recurse `folder` facets, yield `file` items; bounded by max-files / max-depth | `async *walkDocs(driveId, folderId): DriveFile` | GraphClient |
| `clients/sharepoint/extract.ts` | Dispatch by extension/mime → mammoth (docx), SheetJS (xlsx), pptx parser (pptx), pdf-parse (pdf); unknown → skip with reason | `extractText(name, bytes): { text } \| { skipped: reason }` | parser libs |
| `clients/sharepoint/types.ts` | `DriveItem`, `DriveFile`, `SharePointConfig`, result types | — | — |
| `services/sharepoint/index.ts` `SharePointService` | Orchestrate locate → walk → download+extract (bounded concurrency + politeness) → budget-assemble; estimate tokens (`chars/4`, no tokenizer dep) | `getIncidentDocuments(inc): IncidentDocsResult` | the above + config |

Wired into `McpRuntime` (`packages/core/src/runtime.ts`) as `runtime.sharePoint`, constructed only when `SHAREPOINT_ENABLED`.

---

## 5. Tool contract

`get_incident_documents` — same `defineTool` shape as existing tools: `skipPermission: true` (read-only), handler catches all errors → `{ error: String(err) }`, never throws.

**Input**
```ts
{ incident: string }   // e.g. "INC123456"; used only as a startswith filter
```

**Output (success)**
```ts
{
  incident: "INC123456",
  folder: { name: "INC123456 iDeal", webUrl: string },
  count: number,                 // documents extracted
  documents: [{
    name: string, path: string, webUrl: string,
    format: "docx" | "xlsx" | "pptx" | "pdf",
    bytes: number, textChars: number, truncated: boolean,
    text: string                 // extracted, possibly per-doc capped
  }],
  totalChars: number,
  truncatedCount: number,        // docs whose text was cut to fit the budget
  skipped: [{ name: string, reason: string }]  // unknown format, parse error, too big
}
```

**Output (not found)** `{ error: "No SharePoint folder found for INC123456" }`

**Budget / truncation rule:** documents are assembled in walk order against a single running budget (`SHAREPOINT_MAX_DOC_TOKENS`, estimated `chars/4`). When adding a document would exceed the remaining budget, its text is cut to the remaining budget and `truncated: true` is set; once the budget is exhausted, further documents are still listed (name/path/webUrl/bytes) with empty `text` and `truncated: true`, and `truncatedCount` counts every cut-or-empty doc. No per-document cap beyond this shared budget.

---

## 6. Configuration

New env (mirrors `AdoConfig` shape in `config.ts`); a `SharePointConfig` interface + a `sharePoint` block on `AppConfig`.

| Env | Default | Purpose |
|---|---|---|
| `SHAREPOINT_ENABLED` | `false` | Gate runtime wiring + tool registration + chat steering |
| `SHAREPOINT_SITE_URL` | — (required when enabled) | e.g. `https://acme.sharepoint.com/sites/SRE`; resolved to `siteId` + default drive |
| `SHAREPOINT_INCIDENT_ROOT` | `""` (drive root) | Folder holding the `INC######` folders |
| `SHAREPOINT_DOCS_SUBFOLDER` | `Docs` | Subfolder to recurse |
| `SHAREPOINT_AUTH_MODE` | `azcli` | Reserved; future `appcert` for app-only |
| `AZ_PATH` | `az` | Reused from ADO config |
| `SHAREPOINT_PROXY` | — | HTTP proxy for Graph calls (corporate net) |
| `SHAREPOINT_MAX_DOC_TOKENS` | `50000` | Inline budget across all docs (≈ `chars/4`) |
| `SHAREPOINT_MAX_FILES` | `50` | Walk bound (count) |
| `SHAREPOINT_MAX_FILE_BYTES` | `10485760` | Skip files larger than this |
| `SHAREPOINT_TIMEOUT_MS` | `30000` | Per Graph request |

Validation (when `SHAREPOINT_ENABLED=true`): `SHAREPOINT_SITE_URL` required — fail fast in `loadConfig`, matching the existing `ADO_ENABLED` guard.

---

## 7. Auth & preflight

- Token: `az account get-access-token --resource https://graph.microsoft.com` via `AzRunner.json`, cached in-memory until `expiresOn` (minus a skew margin), refreshed on demand.
- Delegated identity → the agent sees exactly what the logged-in user can see in SharePoint. No app registration.
- **`doctor` gains a SharePoint preflight** (only when enabled): acquire token → resolve site → list one page of the base folder. Reports clear pass/fail.
- If conditional access blocks the delegated Graph token, the failure is surfaced with a clear message; app-only `Sites.Selected` is the documented fallback (deferred, §10).

---

## 8. Security

- **Site + drive are pinned by config, never model-supplied.** The tool's only input is the incident number, used as a `startswith` filter against the configured base folder. The model cannot redirect the fetch to an arbitrary site/host — directly mirrors the crawler seed-scope SSRF fix.
- Token held in memory only; never logged or returned.
- Download size bounded (`SHAREPOINT_MAX_FILE_BYTES`) and file count bounded (`SHAREPOINT_MAX_FILES`) to cap memory and call volume.
- Read-only: no write/upload/delete surface.

---

## 9. Error handling

Follows the existing tool convention (handlers return `{ error }`, never throw):
- Graph `429` → honor `Retry-After`, bounded retries, then surface.
- Folder not found → `{ error: "No SharePoint folder found for <INC#>" }`.
- Auth failure → `{ error: "SharePoint auth failed: <msg>" }` (doctor explains remediation).
- Single-document parse failure or unknown format → skip that doc, add to `skipped[]`, continue (never fail the whole call).
- Integration disabled → tool is not registered (gated like `knowledgeEnabled`).

---

## 10. Scope cuts (YAGNI — deferred, not in v1)

| Item | Why deferred |
|---|---|
| **Embed-overflow into RAG store** | Needs a per-incident source-tag filter in the knowledge store + a `query` param on the tool. v1 truncates over budget and reports `truncatedCount`. Add only if real incidents prove large. |
| **App-only auth (`Sites.Selected`)** | Needs admin grant + cert/secret. v1 uses delegated az token. `SHAREPOINT_AUTH_MODE` reserved for it. |
| **`IncidentNoteBook` / OneNote** | Different (non-text-extractable) format; out of scope. |
| **xlsx / pptx fidelity** | Best-effort text dump; tables/slides lose structure. Acceptable; noted in output. |
| **Write-back to SharePoint** | Read-only integration. |

---

## 11. Chat / RAG steering

- Extend (or add alongside) the existing system-prompt nudge: "When the user references an incident number and SharePoint is configured, call `get_incident_documents` to pull its incident documents." Gated on `SHAREPOINT_ENABLED`.
- Add a `get_incident_documents` step to the `/triage`, `/postmortem`, and `/handover` workflow prompts (incident-centric flows), consistent with how `search_knowledge` was wired in.

---

## 12. Testing

All mocked — no live tenant in CI (vitest, matching the existing 244-test suite):
- **Unit:** GraphClient pagination + `429`/`Retry-After` (mock fetch); site resolve; locate `startswith` (incl. case + non-match); walk recursion over a folder/file-facet tree fixture (incl. nested + pagination); extract dispatch per format with tiny fixtures; token estimate + budget truncation.
- **Service:** `getIncidentDocuments` orchestration against a faked `GraphClient` — locate→walk→extract→assemble, including overflow/truncation and skip paths.
- **Tool:** projected JSON shape + `{ error }` on thrown handler.
- **Manual:** `doctor` SharePoint preflight + one real `get_incident_documents` against the tenant, documented in the README.

---

## 13. Files touched (anticipated)

- **New:** `packages/core/src/clients/sharepoint/{graph,site,locate,walk,extract,types,index}.ts`; `packages/core/src/services/sharepoint/index.ts`; tests alongside.
- **Edited:** `packages/core/src/config.ts` (env + `SharePointConfig`), `packages/core/src/runtime.ts` (wire `runtime.sharePoint`), `packages/sre-agent/src/tools/index.ts` + `packages/mcp-server/src/tools/*` (tool), `packages/sre-agent/src/engine/engine.ts` (steering nudge), `packages/sre-agent/src/workflows/index.ts` (workflow steps), `packages/sre-agent/src/doctor.ts` (preflight), `packages/sre-agent/.env.example` + READMEs (docs).
- **Deps:** `mammoth` (docx), `xlsx`/SheetJS (xlsx), a pptx text extractor, `pdf-parse` (pdf).
