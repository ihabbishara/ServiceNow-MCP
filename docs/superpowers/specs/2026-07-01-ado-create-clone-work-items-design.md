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

### Runtime

`createMcpRuntime` instantiates `WorkItemService` and exposes it as
`runtime.workItemService`.

### MCP tools

`packages/mcp-server/src/tools/ado.ts` gains `create_work_item` and
`clone_work_item`, thin handlers that call `runtime.workItemService`, guarded by
the same `azureDevOps.enabled` check as the existing tools, following the
established `server.tool(...)` pattern.

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

## Out of scope (deferred)

- ADO Teams-API resolution of board/team name → area path (config map only for
  now).
- Bulk create, cross-project clone, editing/updating existing items, deleting.
- Board column / swimlane placement beyond area path + type.

## Files touched

- `packages/core/src/clients/ado/types.ts` — new payload types + interface methods.
- `packages/core/src/clients/ado/index.ts` — `AdoPatClient` new methods; `createBug` delegates.
- `packages/core/src/clients/ado/azBoards.ts` — `AzBoardsClient` new methods; `createBug` delegates.
- `packages/core/src/services/workItemService.ts` — new.
- `packages/core/src/config.ts` — `ADO_BOARD_MAP` → `boardMap`.
- `packages/core/src/runtime.ts` — instantiate `workItemService`.
- `packages/core/src/index.ts` — export new service/types if needed.
- `packages/mcp-server/src/tools/ado.ts` — two new tools.
- Tests under `packages/core/tests/` (and mcp-server tests if present).
