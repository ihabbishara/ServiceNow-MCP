# Settings Env Coverage — Design

**Date:** 2026-07-07
**Status:** Approved

## Problem

The web Settings tab renders only env keys present in the user's `.env` file
(`EnvSettings.tsx` iterates `Object.keys(vars)`), and the curated field
catalog (`ENV_FIELDS` in `packages/web/client/src/views/env-fields.ts`) is
missing several real vars — notably `GIT_WORKSPACE_DIR`. Result: users cannot
discover settings they haven't already written into `.env`; the git-analysis
workspace looks unconfigurable from the UI.

## Decision (user-confirmed)

1. Cataloged fields are **always visible** in Settings, empty when unset.
2. Catalog every missing env var (full coverage), not just the git one.
3. Saving must not spam `KEY=""` lines into `.env` for untouched empty fields.

## Architecture

### 1. Catalog completion — `env-fields.ts`

Add entries for every env var the app reads that is missing from
`ENV_FIELDS`. Known-missing set (implementer must verify by enumerating
`Object.keys(envSchema.shape)` from `@sre/core` plus the sre-agent extended
env keys, and diffing against the catalog):

| Key | Group | Label / description gist |
|---|---|---|
| `GIT_WORKSPACE_DIR` | Azure DevOps | "Git workspace dir" — directory for incident-analysis repo checkouts; default OS temp dir (auto-cleaned by the OS); shallow read-only clones |
| `ADO_BOARD_MAP` | Azure DevOps | JSON map of team → board name for work-item creation |
| `ADO_CSV_DIR` | Azure DevOps | Folder of work-item CSV files the agent may ingest |
| `ADO_CSV_MAX_BYTES` | Azure DevOps | Max CSV file size (default 5 MB) |
| `SHAREPOINT_MAX_DOC_TOKENS` | SharePoint | Token cap per extracted document (default 50000) |
| `SHAREPOINT_MAX_FILES` | SharePoint | Max files per incident folder sweep (default 50) |
| `SHAREPOINT_MAX_FILE_BYTES` | SharePoint | Max bytes per document (default 10 MB) |
| `SHAREPOINT_TIMEOUT_MS` | SharePoint | Per-call timeout (default 30000) |
| `WEB_PORT` | Other | Web UI port (default per server) |
| `COPILOT_CLI_PATH` | LLM & Copilot | Path to the copilot CLI binary the SDK runtime uses |

(Descriptions in the implementation should match `.env.example` comments and
config defaults; the table gives the gist, not final copy.)

### 2. Always-visible cataloged fields — `EnvSettings.tsx`

Per group, render the **union** of catalog keys and file keys:

- Order: catalog declaration order first, then file-only extras (uncataloged
  keys found in `.env` keep today's fall-to-"Other" behavior).
- Unset keys render as empty inputs (`vars[k] ?? ""`); typing into one stages
  it like any other edit.

Extract a pure helper into `env-fields.ts` so this is unit-testable without
DOM:

```ts
/** Union of catalog + file keys for one group: catalog order first, file-only extras after. */
export const visibleKeys = (group: EnvGroup, fileKeys: string[]): string[]
```

### 3. No-churn save

New pure helper in `env-fields.ts`:

```ts
/** Drop empty-valued keys that were not in the originally-loaded file (avoid KEY="" spam); keep empty values for keys the user is clearing. */
export const varsToSave = (
  vars: Record<string, string>,
  originalKeys: string[]
): Record<string, string>
```

`EnvSettings.tsx` records the originally-loaded key set on fetch and passes
`varsToSave(vars, originalKeys)` to the save call. Existing clear semantics
preserved: a key present in the file and blanked by the user still writes
`KEY=`.

### 4. Drift guard test

A completeness test in `packages/web/tests` asserting every key of the core
`envSchema` (`Object.keys(envSchema.shape)` imported from `@sre/core`) has an
`ENV_FIELDS` entry, plus a small hardcoded list for the sre-agent-only keys
(`WEB_PORT`, `COPILOT_CLI_PATH`, `TURN_TIMEOUT_MS`, `CONFIRM_WRITES`,
`COPILOT_GITHUB_TOKEN`, `COPILOT_HOME`, `COPILOT_IGNORE_ENV_TOKEN`,
`CRAWL_TTL_HOURS`, `UPLOAD_MAX_BYTES`). New env vars then fail CI until
cataloged — the discoverability gap cannot silently reopen.

## Error handling

Pure helpers; no new failure paths. Server `applyEnv` validation unchanged —
it already rejects invalid combinations before writing.

## Testing

- `visibleKeys`: catalog-only, file-only, union ordering, group filtering.
- `varsToSave`: unset-empty dropped; originally-present empty kept (clear);
  non-empty always kept.
- Catalog: `GIT_WORKSPACE_DIR` present in the Azure DevOps group with
  non-trivial description; drift-guard completeness test as above.
- Existing EnvSettings behavior tests (if any) stay green.

## Out of scope (deliberate)

- Grouping/UI redesign, search, or per-field validation.
- Editing vars the app never reads.
- Server-side changes (`readEnv`/`applyEnv` contracts untouched).
