# ADO Create & Clone Work Items — Design

**Date:** 2026-07-01
**Status:** Approved (design)

## Goal

Extend the Azure DevOps integration beyond search/get. Add the ability to
**create** any work item type (User Story, Task, Bug, Feature, Epic, Issue) on
a specific board or backlog, and to **clone** an existing work item (typically a
story) from one board to another.

## Background (current state)

- `AzureDevOpsClient` interface (`packages/core/src/clients/ado/types.ts`) has 3
  methods: `searchWorkItems`, `getWorkItem`, `createBug`.
- Two implementations, selected at runtime by `createAdoClient`:
  - `AdoPatClient` — REST, Basic auth with a PAT (`packages/core/src/clients/ado/index.ts`).
  - `AzBoardsClient` — wraps the `az boards` CLI (`packages/core/src/clients/ado/azBoards.ts`).
- `createBug` is hardcoded to type `$Bug` and writes the description to
  `Microsoft.VSTS.TCM.ReproSteps`.
- MCP tools live in `packages/mcp-server/src/tools/ado.ts`
  (`search_work_items`, `create_bug_from_incident`).
- Config (`packages/core/src/config.ts`) exposes `orgUrl`, `project`, `pat`,
  `authMode`, `defaultAreaPath`, `defaultIterationPath`, `defaultAssignedTeam`.
- Target org uses **azcli auth (no PAT)** — the `az boards` path is the primary
  one to exercise, but the interface contract requires both clients implement
  every method.

## Key domain facts

- ADO has **no "board" create-target**. A board/backlog is a *view* derived from
  a team's **area path** plus the work-item-type / backlog level. "Create on
  board X" reduces to "set the correct area path + type". Naming a board
  requires translating board/team name → area path.
- A "Task on a story" is a normal work item with a `System.Parent` link to the
  story. Same for Story→Feature, Feature→Epic.
- "Clone" is not an ADO primitive. It is: read source fields → create a new item
  with those fields (area path overridden to the target) → optionally copy child
  items → optionally add a Related link back to the source.

## Decisions (from brainstorming)

1. **Board targeting: both.** Explicit `area_path` always wins. Optional
   `board`/team name resolves to an area path via a config map. Config-map-first
   (no API call); ADO Teams-API resolution is deferred (add when a map entry is
   missing).
2. **Clone: per-call flags.** `include_children` (copy child Tasks) and
   `link_to_source` (Related link back) are optional booleans on each call.
3. **Clone field defaults:** carry over title (+ optional prefix), description,
   type, tags, priority, story points, acceptance criteria; set area/iteration to
   the target; **reset** state → New and **clear** `assignedTo`. `overrides`
   patches any field.
4. **CSV via dedicated folder, not RAG.** The knowledge/RAG pipeline embeds
   uploads into vector chunks and discards the original file, so it cannot return
   CSV rows/columns faithfully. Instead, a dedicated raw-CSV folder
   (`ADO_CSV_DIR`) is read directly. Tools return **structured rows**; the agent
   detects which rows are stories/tasks and loops the create/clone tools. No
   server-side bulk mapper (detection is LLM judgment).
5. **A canonical CSV template ships with the repo** so users fill-and-drop.

## New MCP tools

### `create_work_item`

```
type            "User Story" | "Task" | "Bug" | "Feature" | "Epic" | "Issue"   (required)
title           string                                                          (required)
description?    string
area_path?      string    # explicit; overrides board
iteration_path? string
board?          string    # resolved to area_path via config map
tags?           string[]
assigned_to?    string    # email/display name
priority?       "1".."4"
story_points?   number
parent_id?      number    # adds System.Parent link (task→story, story→feature)
```

Behavior: resolve area path (`area_path` > `board` map lookup > config default) →
`createWorkItem` → if `parent_id` set, `addRelation(newId, parent_id, "parent")`.
Returns the created work item (id, title, type, state, areaPath).

### `clone_work_item`

```
source_id        number    (required)
board?           string
area_path?       string
iteration_path?  string
include_children boolean   default false
link_to_source   boolean   default false
title_prefix?    string
overrides?       object    # patch any create field (title, priority, tags, assigned_to, ...)
```

Behavior: read source fields → build a create payload (carry-over rules above,
apply `overrides`) → create the clone at the target area path → if
`include_children`, list source children and copy each (create + parent link to
the clone) → if `link_to_source`, add a Related link between clone and source.
Returns `{ cloneId, sourceId, childrenCopied, linked }`.

`create_bug_from_incident` is unchanged (remains ServiceNow-coupled).

## Core changes

### Client interface — 4 new primitives

Added to `AzureDevOpsClient` and implemented in **both** `AdoPatClient` and
`AzBoardsClient`:

- `createWorkItem(p: CreateWorkItemPayload): Promise<WorkItem>` — general
  creator. **`createBug` is refactored to delegate to it** (type `Bug`, keeps
  the `ReproSteps` description mapping), removing duplication.
- `getWorkItemFields(id: number): Promise<Record<string, unknown> | null>` — raw
  fields needed for clone (existing `getWorkItem` returns only 5 mapped fields).
- `listChildren(parentId: number): Promise<number[]>` — child ids, for
  `include_children`.
- `addRelation(fromId: number, toId: number, relType: "parent" | "related"): Promise<void>`
  — parent and Related links.

New payload types (in `types.ts`):

```ts
interface CreateWorkItemPayload {
  type: string;
  title: string;
  description?: string;
  areaPath?: string;
  iterationPath?: string;
  tags?: string[];
  assignedTo?: string;
  priority?: string;      // "1".."4"
  storyPoints?: number;
  fields?: Record<string, string>; // escape hatch for extra raw fields
}
// Note: parent linking is NOT part of this payload. The client's
// createWorkItem stays link-free; the WorkItemService takes the tool's
// parent_id and issues a separate addRelation after creation.

interface CloneWorkItemPayload {
  sourceId: number;
  areaPath?: string;
  iterationPath?: string;
  includeChildren?: boolean;
  linkToSource?: boolean;
  titlePrefix?: string;
  overrides?: Partial<CreateWorkItemPayload>;
}
```

Implementation notes:
- **REST (`AdoPatClient`):**
  - create: `POST wit/workitems/${encodeURIComponent("$" + type)}?api-version=7.1`
    with a json-patch body (mirror `createBug`; description → `System.Description`
    for non-Bug types, `ReproSteps` for Bug).
  - fields: `GET wit/workitems/${id}?$expand=fields&api-version=7.1`.
  - children: WIQL `SELECT [System.Id] FROM WorkItemLinks WHERE
    [Source].[System.Id] = <id> AND [System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward'`
    (or query `[System.Parent] = <id>`), returning target ids.
  - relation: `PATCH wit/workitems/${fromId}?api-version=7.1` adding a
    `relations` op (`System.LinkTypes.Hierarchy-Reverse` for parent,
    `System.LinkTypes.Related` for related).
- **CLI (`AzBoardsClient`):**
  - create: `az boards work-item create --type <type> --title ... --area ...
    --iteration ... --fields ...`.
  - fields: `az boards work-item show --id <id> --expand fields`.
  - children: `az boards query --wiql "... [System.Parent] = <id> ..."`.
  - relation: `az boards work-item relation add --id <from> --relation-type
    parent|related --target-id <to>`.

### `WorkItemService` (new, `packages/core/src/services/`)

Holds orchestration **once** against the client interface (tested once, not per
client):

- `resolveAreaPath(board?: string, areaPath?: string): string | undefined` —
  `areaPath` > `boardMap[board]` > `defaultAreaPath`.
- `create(input): Promise<WorkItem>` — resolve area path → `createWorkItem` →
  optional parent link.
- `clone(input): Promise<CloneResult>` — orchestration described above.

### Config

New optional env `ADO_BOARD_MAP` — JSON object string, e.g.
`{"Team Alpha":"Platform\\TeamAlpha"}`. Parsed in `config.ts` into
`azureDevOps.boardMap: Record<string, string>` (empty object if unset/invalid;
invalid JSON logs a warning and is ignored, never throws).

New optional env `ADO_CSV_DIR` — absolute path to a folder holding raw CSV
files. Parsed into `azureDevOps.csvDir?: string`. When unset, the CSV tools are
inert (return a disabled message).

### Runtime

`createMcpRuntime` instantiates `WorkItemService` and exposes it as
`runtime.workItemService`.

### MCP tools

`packages/mcp-server/src/tools/ado.ts` gains `create_work_item` and
`clone_work_item`, thin handlers that call `runtime.workItemService`, guarded by
the same `azureDevOps.enabled` check as the existing tools, following the
established `server.tool(...)` pattern.

## CSV-driven creation (folder + template)

Ad-hoc bulk work: a user drops a CSV of stories/tasks into `ADO_CSV_DIR`; the
agent reads it, detects the rows, and loops the create/clone tools. RAG is
bypassed entirely (it embeds+discards files; see Decision 4).

### CSV reader (core, `packages/core/src/services/csvReader.ts`)

A small module — **not** part of `AzureDevOpsClient`:

```ts
interface CsvTable { headers: string[]; rows: Record<string, string>[]; rowCount: number; }

function listCsvFiles(dir: string): Promise<{ name: string; sizeBytes: number; modified: string }[]>;
function readCsvFile(dir: string, filename: string, maxBytes: number): Promise<CsvTable>;
```

- Parsing uses the **`csv-parse`** dependency (`csv-parse/sync`, `columns: true`,
  `skip_empty_lines: true`, `trim: true`) — a battle-tested parser that handles
  quoted fields, embedded commas, and newlines. Hand-rolling CSV is explicitly
  rejected.
- **Path-traversal guard (trust boundary):** `readCsvFile` rejects a `filename`
  that contains a path separator or `..`, resolves it against `dir`, and asserts
  the resolved absolute path starts with `dir + path.sep`. Only a `.csv`
  extension is allowed. Files larger than `maxBytes` are rejected before parse.

### MCP tools (new file `packages/mcp-server/src/tools/workItemCsv.ts`)

- `list_work_item_csvs` → `{ files: [{ name, sizeBytes, modified }] }` for files
  in `ADO_CSV_DIR`.
- `read_work_item_csv({ filename })` → `{ headers, rows, rowCount }`. The agent
  then classifies rows and calls `create_work_item` / `clone_work_item` per row.

Both are guarded by `azureDevOps.enabled` **and** a configured `csvDir`; unset
`csvDir` returns a disabled message naming the `ADO_CSV_DIR` env var.

### CSV template (shipped, `templates/work-items.csv`)

Canonical columns the agent understands. All values are strings; blank = omit.
`tags` is `;`-separated; booleans are `true`/`false`/blank.

| column | required | applies to | meaning |
|---|---|---|---|
| `action` | no (default `create`) | both | `create` or `clone` |
| `ref` | no | create | row-local key for intra-CSV parent linking |
| `type` | yes for `create` | create | `User Story` / `Task` / `Bug` / `Feature` / `Epic` / `Issue` |
| `title` | yes for `create` | create; clone override | work item title |
| `description` | no | create; clone override | body |
| `board` | no | both | friendly board/team name → area path |
| `area_path` | no | both | explicit; overrides `board` |
| `iteration_path` | no | both | iteration/sprint path |
| `tags` | no | create; clone override | `;`-separated |
| `assigned_to` | no | create; clone override | email/display name |
| `priority` | no | create; clone override | `1`–`4` |
| `story_points` | no | create; clone override | number |
| `parent_id` | no | create | link under an existing ADO parent id |
| `parent_ref` | no | create | link under another row's `ref` (agent resolves order) |
| `source_id` | yes for `clone` | clone | id of the item to clone |
| `include_children` | no | clone | `true`/`false` |
| `link_to_source` | no | clone | `true`/`false` |

Example (`templates/work-items.csv`):

```csv
action,ref,type,title,description,board,area_path,iteration_path,tags,assigned_to,priority,story_points,parent_id,parent_ref,source_id,include_children,link_to_source
create,S1,User Story,Add SSO login,Users can sign in via corporate SSO,Team Alpha,,,auth;security,,2,5,,,,,
create,,Task,Wire up OIDC client,Configure the OIDC redirect + token exchange,Team Alpha,,,auth,,2,,,S1,,,
clone,,,,,Team Beta,,,,,,,,,1234,true,true
```

Row 1 creates a story (`ref` S1); row 2 creates a task linked under S1 via
`parent_ref`; row 3 deep-clones item 1234 to Team Beta with a backlink.

**Intra-CSV parenting is agent logic, not server logic:** the agent creates
`ref`-parents first, captures the returned ids, then creates `parent_ref`
children with the real `parent_id`. `csvReader` just returns rows; ordering and
`ref` resolution live in the agent's loop.

**Template access:** the file is committed to the repo. A `get_csv_template`
tool is deferred (out of scope) — the agent can read the committed file or
describe the columns from this spec.

## Error handling

- Tools return `{ isError: true }` with a readable message when ADO is disabled
  or the client throws (mirrors existing tools).
- `WorkItemService.clone` throws a clear error if `source_id` is not found
  (client already throws on non-2xx / non-zero `az`).
- Invalid `ADO_BOARD_MAP` JSON is ignored with a warning; the map is treated as
  empty rather than crashing startup.
- Unknown `board` name (not in map) falls back to `defaultAreaPath`; if that is
  also unset, the item is created without an explicit area path (ADO uses the
  project root), and the tool response notes that the board name was
  unresolved.
- CSV tools return a readable error when `csvDir` is unset, the file is missing,
  the filename fails the path-traversal guard, the extension is not `.csv`, or
  the file exceeds `maxBytes`. A malformed CSV surfaces the parser error rather
  than a partial table.

## Testing

- **`WorkItemService`** unit tests (mocked `AzureDevOpsClient`):
  create + parent link, clone shallow, clone deep (children copied), clone with
  `link_to_source`, board→area resolution and override precedence, clone
  field-reset defaults (state/assignee), `overrides` application.
- **Client tests, both impls** (`AdoPatClient` via fetch mock, `AzBoardsClient`
  via `AzRunner` mock): `createWorkItem` builds the right request/args per type,
  `addRelation` maps rel types correctly, `listChildren` parses ids,
  `createBug` still behaves identically after delegating to `createWorkItem`.
- **Tool tests** (if the existing suite covers tools): `create_work_item` and
  `clone_work_item` disabled-guard and happy path against a stub runtime.
- **`csvReader`** unit tests (temp dir): `listCsvFiles` lists only `.csv`;
  `readCsvFile` parses headers/rows including quoted fields with embedded commas
  and newlines; **path-traversal rejection** (`../etc/passwd`, absolute paths,
  nested separators), non-`.csv` rejection, and `maxBytes` rejection.
- **CSV tool tests**: `list_work_item_csvs` / `read_work_item_csv` disabled when
  `csvDir` unset; happy path returns structured rows.

## Out of scope (deferred)

- ADO Teams-API resolution of board/team name → area path (config map only for
  now).
- Bulk create, cross-project clone, editing/updating existing items, deleting.
- Board column / swimlane placement beyond area path + type.
- Server-side `create_all_from_csv` bulk tool (agent loops instead; add if CSVs
  get large enough that per-row round-trips hurt).
- `get_csv_template` MCP tool (template file is committed; agent reads it).

## Files touched

- `packages/core/src/clients/ado/types.ts` — new payload types + interface methods.
- `packages/core/src/clients/ado/index.ts` — `AdoPatClient` new methods; `createBug` delegates.
- `packages/core/src/clients/ado/azBoards.ts` — `AzBoardsClient` new methods; `createBug` delegates.
- `packages/core/src/services/workItemService.ts` — new.
- `packages/core/src/services/csvReader.ts` — new (list + parse CSV, path guard).
- `packages/core/src/config.ts` — `ADO_BOARD_MAP` → `boardMap`; `ADO_CSV_DIR` → `csvDir`.
- `packages/core/src/runtime.ts` — instantiate `workItemService`.
- `packages/core/src/index.ts` — export new service/types if needed.
- `packages/mcp-server/src/tools/ado.ts` — `create_work_item`, `clone_work_item` tools.
- `packages/mcp-server/src/tools/workItemCsv.ts` — new (`list_work_item_csvs`, `read_work_item_csv`).
- `packages/mcp-server/src/tools/index.ts` + `server.ts` — wire new tool registrars.
- `templates/work-items.csv` — new (shipped CSV template).
- `packages/core/package.json` — add `csv-parse` dependency.
- Tests under `packages/core/tests/` (and mcp-server tests if present).
