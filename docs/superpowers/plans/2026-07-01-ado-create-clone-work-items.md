# ADO Create & Clone Work Items — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the Azure DevOps integration to create any work item type on a specific board/backlog, clone a work item across boards, and drive ad-hoc bulk creation from a CSV folder.

**Architecture:** Four thin client primitives (`createWorkItem`, `getWorkItemFields`, `listChildren`, `addRelation`) implemented in **both** the PAT REST client and the `az boards` CLI client. Orchestration (board→area resolution, create-with-parent, clone) lives once in a new `WorkItemService`. CSV ingestion is a standalone `csvReader` module read by two MCP tools; the agent loops the create/clone tools per row. RAG is bypassed — a dedicated `ADO_CSV_DIR` folder is read directly.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `@modelcontextprotocol/sdk`, Zod, Vitest. New dependency: `csv-parse`.

## Global Constraints

- Node ESM: all relative imports use `.js` extensions, even from `.ts` sources.
- ADO REST api-version is `7.1` (matches existing code).
- Every method on the `AzureDevOpsClient` interface MUST be implemented in **both** `AdoPatClient` (`packages/core/src/clients/ado/index.ts`) and `AzBoardsClient` (`packages/core/src/clients/ado/azBoards.ts`), or the `@sre/core` package will not compile.
- MCP tools follow the existing pattern: `server.tool(name, description, zodShape, handler)`, returning `{ content: [{ type: "text", text }] }` and `{ isError: true }` on failure, guarded by `runtime.config.azureDevOps.enabled`.
- No new dependencies except `csv-parse`. Do not hand-roll CSV parsing.
- WIQL/CLI string escaping: reuse the existing single-quote escapes (`escapeWiql` in REST, `esc` in CLI).
- Priority is a string `"1".."4"`; only integers 1–4 map to `Microsoft.VSTS.Common.Priority`, others are dropped (existing behavior).
- Run a single test file with: `cd packages/core && npx vitest run <relative/test/path>`. Typecheck/build a package with: `cd packages/<pkg> && npm run build`.

---

## Phase 1 — Create & clone work items

### Task 1: `createWorkItem` primitive + `createBug` delegation

**Files:**
- Modify: `packages/core/src/clients/ado/types.ts` (add payload type + interface method)
- Modify: `packages/core/src/clients/ado/index.ts` (`AdoPatClient`)
- Modify: `packages/core/src/clients/ado/azBoards.ts` (`AzBoardsClient`)
- Test: `packages/core/tests/clients/ado.test.ts`, `packages/core/tests/clients/azBoards.test.ts`

**Interfaces:**
- Produces: `CreateWorkItemPayload` (below); `AzureDevOpsClient.createWorkItem(p: CreateWorkItemPayload): Promise<WorkItem>`.

- [ ] **Step 1: Add the payload type and interface method**

In `packages/core/src/clients/ado/types.ts`, add above `AzureDevOpsClient`:

```ts
export interface CreateWorkItemPayload {
  type: string; // "User Story" | "Task" | "Bug" | "Feature" | "Epic" | "Issue" | ...
  title: string;
  description?: string;
  areaPath?: string;
  iterationPath?: string;
  tags?: string[];
  assignedTo?: string; // email/display name
  priority?: string; // "1".."4"
  storyPoints?: number;
  fields?: Record<string, string>; // escape hatch for extra raw ADO fields (raw HTML values pass through unchanged)
}
```

And add to the `AzureDevOpsClient` interface:

```ts
  createWorkItem(p: CreateWorkItemPayload): Promise<WorkItem>;
```

Also export the new type from the re-export line at the top of `packages/core/src/clients/ado/index.ts`:

```ts
export type { AzureDevOpsClient, WorkItemSearchFilters, CreateBugPayload, CreateWorkItemPayload } from "./types.js";
```

- [ ] **Step 2: Write failing tests (both clients)**

Append to `packages/core/tests/clients/ado.test.ts` inside the `describe`:

```ts
  it("createWorkItem posts json-patch for a User Story with parent-less fields", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 500, fields: { "System.Title": "Add SSO" } }));
    const wi = await new AdoPatClient(cfg).createWorkItem({
      type: "User Story",
      title: "Add SSO",
      description: "line1\nline2",
      areaPath: "Platform\\Alpha",
      tags: ["auth"],
      assignedTo: "jane@x.com",
      priority: "2",
      storyPoints: 5
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://dev.azure.com/acme/Platform/_apis/wit/workitems/%24User%20Story?api-version=7.1");
    const ops = JSON.parse(init.body as string) as Array<{ op: string; path: string; value: string | number }>;
    expect(ops).toContainEqual({ op: "add", path: "/fields/System.Title", value: "Add SSO" });
    expect(ops).toContainEqual({ op: "add", path: "/fields/System.Description", value: "line1<br>line2" });
    expect(ops).toContainEqual({ op: "add", path: "/fields/System.AreaPath", value: "Platform\\Alpha" });
    expect(ops).toContainEqual({ op: "add", path: "/fields/System.Tags", value: "auth" });
    expect(ops).toContainEqual({ op: "add", path: "/fields/System.AssignedTo", value: "jane@x.com" });
    expect(ops).toContainEqual({ op: "add", path: "/fields/Microsoft.VSTS.Common.Priority", value: 2 });
    expect(ops).toContainEqual({ op: "add", path: "/fields/Microsoft.VSTS.Scheduling.StoryPoints", value: 5 });
    expect(wi).toMatchObject({ id: 500, title: "Add SSO" });
  });

  it("createWorkItem routes a Bug description to ReproSteps", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 1, fields: { "System.Title": "b" } }));
    await new AdoPatClient(cfg).createWorkItem({ type: "Bug", title: "b", description: "x\ny" });
    const ops = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(ops).toContainEqual({ op: "add", path: "/fields/Microsoft.VSTS.TCM.ReproSteps", value: "x<br>y" });
    expect(ops.some((o: { path: string }) => o.path === "/fields/System.Description")).toBe(false);
  });
```

Append to `packages/core/tests/clients/azBoards.test.ts` inside the `describe`:

```ts
  it("createWorkItem shells az create with type, area, and mapped fields", async () => {
    const runner = makeRunner(() => ({ id: 7, fields: { "System.Title": "Add SSO", "System.WorkItemType": "User Story" } }));
    const client = new AzBoardsClient(cfg as any, runner as any);
    const wi = await client.createWorkItem({
      type: "User Story", title: "Add SSO", description: "a\nb",
      areaPath: "IngOne\\Alpha", assignedTo: "jane@x.com", priority: "2", storyPoints: 5, tags: ["auth"]
    });
    const args = (runner.json as any).mock.calls[0][0] as string[];
    expect(args.slice(0, 3)).toEqual(["boards", "work-item", "create"]);
    expect(args).toContain("--type");
    expect(args).toContain("User Story");
    expect(args).toContain("--area");
    expect(args).toContain("IngOne\\Alpha");
    expect(args).toContain("--assigned-to");
    expect(args).toContain("jane@x.com");
    expect(args).toContain("--fields");
    expect(args).toContain("System.Description=a<br>b");
    expect(args).toContain("System.Tags=auth");
    expect(args).toContain("Microsoft.VSTS.Common.Priority=2");
    expect(args).toContain("Microsoft.VSTS.Scheduling.StoryPoints=5");
    expect(wi.id).toBe(7);
    expect(wi.workItemType).toBe("User Story");
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd packages/core && npx vitest run tests/clients/ado.test.ts tests/clients/azBoards.test.ts`
Expected: FAIL — `createWorkItem` does not exist on the clients.

- [ ] **Step 4: Implement `createWorkItem` + delegate `createBug` (REST)**

In `packages/core/src/clients/ado/index.ts`, add a private ops builder and the method to `AdoPatClient`, and rewrite `createBug` to delegate. Import `mapAzWorkItem`/`AzWorkItemRaw` are already imported.

```ts
  private buildCreateOps(p: CreateWorkItemPayload): Array<{ op: "add"; path: string; value: string | number }> {
    const ops: Array<{ op: "add"; path: string; value: string | number }> = [
      { op: "add", path: "/fields/System.Title", value: p.title }
    ];
    if (p.description != null) {
      const html = p.description.replace(/\n/g, "<br>");
      const path = p.type === "Bug" ? "/fields/Microsoft.VSTS.TCM.ReproSteps" : "/fields/System.Description";
      ops.push({ op: "add", path, value: html });
    }
    const areaPath = p.areaPath ?? this.cfg.defaultAreaPath;
    const iterationPath = p.iterationPath ?? this.cfg.defaultIterationPath;
    if (areaPath) ops.push({ op: "add", path: "/fields/System.AreaPath", value: areaPath });
    if (iterationPath) ops.push({ op: "add", path: "/fields/System.IterationPath", value: iterationPath });
    if (p.tags?.length) ops.push({ op: "add", path: "/fields/System.Tags", value: p.tags.join("; ") });
    if (p.assignedTo) ops.push({ op: "add", path: "/fields/System.AssignedTo", value: p.assignedTo });
    const prio = p.priority ? Number(p.priority) : NaN;
    if (Number.isInteger(prio) && prio >= 1 && prio <= 4) {
      ops.push({ op: "add", path: "/fields/Microsoft.VSTS.Common.Priority", value: prio });
    }
    if (typeof p.storyPoints === "number") {
      ops.push({ op: "add", path: "/fields/Microsoft.VSTS.Scheduling.StoryPoints", value: p.storyPoints });
    }
    for (const [k, v] of Object.entries(p.fields ?? {})) ops.push({ op: "add", path: `/fields/${k}`, value: v });
    return ops;
  }

  async createWorkItem(p: CreateWorkItemPayload): Promise<WorkItem> {
    if (!this.cfg.enabled) throw new Error("ADO integration is disabled");
    this.assertConfigured();
    const created = await this.requestJson<AzWorkItemRaw>(
      this.apiUrl(`wit/workitems/${encodeURIComponent("$" + p.type)}?api-version=7.1`),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json-patch+json",
          Accept: "application/json",
          Authorization: this.authHeader
        },
        body: JSON.stringify(this.buildCreateOps(p))
      }
    );
    return mapAzWorkItem(created);
  }
```

Add the import for the payload type at the top (already re-exported; add to the value/type import from `./types.js`):

```ts
import type { AzureDevOpsClient, WorkItemSearchFilters, CreateBugPayload, CreateWorkItemPayload } from "./types.js";
```

Replace the existing `createBug` body in `AdoPatClient` with a delegation:

```ts
  async createBug(p: CreateBugPayload): Promise<{ id: number; title: string }> {
    const wi = await this.createWorkItem({
      type: "Bug",
      title: p.title,
      description: p.description,
      areaPath: p.areaPath,
      iterationPath: p.iterationPath,
      tags: p.tags,
      priority: p.priority
    });
    return { id: wi.id, title: wi.title };
  }
```

- [ ] **Step 5: Implement `createWorkItem` + delegate `createBug` (CLI)**

In `packages/core/src/clients/ado/azBoards.ts`, add `CreateWorkItemPayload` to the type import and add the method; rewrite `createBug` to delegate.

Import line becomes:

```ts
import type { AzureDevOpsClient, WorkItemSearchFilters, CreateBugPayload, CreateWorkItemPayload } from "./types.js";
```

Add to `AzBoardsClient`:

```ts
  async createWorkItem(p: CreateWorkItemPayload): Promise<WorkItem> {
    const area = p.areaPath ?? this.cfg.defaultAreaPath;
    const iter = p.iterationPath ?? this.cfg.defaultIterationPath;
    const fields: string[] = [];
    if (p.description != null) {
      const html = p.description.replace(/\n/g, "<br>");
      fields.push(p.type === "Bug" ? `Microsoft.VSTS.TCM.ReproSteps=${html}` : `System.Description=${html}`);
    }
    if (p.tags?.length) fields.push(`System.Tags=${p.tags.join("; ")}`);
    const prio = p.priority ? Number(p.priority) : NaN;
    if (Number.isInteger(prio) && prio >= 1 && prio <= 4) fields.push(`Microsoft.VSTS.Common.Priority=${prio}`);
    if (typeof p.storyPoints === "number") fields.push(`Microsoft.VSTS.Scheduling.StoryPoints=${p.storyPoints}`);
    for (const [k, v] of Object.entries(p.fields ?? {})) fields.push(`${k}=${v}`);

    const args = [
      "boards", "work-item", "create", "--type", p.type, "--title", p.title,
      "--org", this.cfg.orgUrl, "--project", this.cfg.project
    ];
    if (area) args.push("--area", area);
    if (iter) args.push("--iteration", iter);
    if (p.assignedTo) args.push("--assigned-to", p.assignedTo);
    if (fields.length) args.push("--fields", ...fields);

    const row = await this.runner.json<AzWorkItemRaw>(args);
    return mapAzWorkItem(row);
  }
```

Replace the existing `createBug` in `AzBoardsClient` with:

```ts
  async createBug(p: CreateBugPayload): Promise<{ id: number; title: string }> {
    if (!this.cfg.createBugEnabled) throw new Error("ADO bug creation is disabled");
    const wi = await this.createWorkItem({
      type: "Bug",
      title: p.title,
      description: p.description,
      areaPath: p.areaPath,
      iterationPath: p.iterationPath,
      tags: p.tags,
      priority: p.priority
    });
    return { id: wi.id, title: wi.title || p.title };
  }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd packages/core && npx vitest run tests/clients/ado.test.ts tests/clients/azBoards.test.ts`
Expected: PASS — including the pre-existing `createBug` tests (delegation preserves behavior).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/clients/ado/types.ts packages/core/src/clients/ado/index.ts packages/core/src/clients/ado/azBoards.ts packages/core/tests/clients/ado.test.ts packages/core/tests/clients/azBoards.test.ts
git commit -m "feat(ado): add generalized createWorkItem; createBug delegates to it"
```

---

### Task 2: Clone primitives — `getWorkItemFields`, `listChildren`, `addRelation`

**Files:**
- Modify: `packages/core/src/clients/ado/types.ts`
- Modify: `packages/core/src/clients/ado/index.ts`, `packages/core/src/clients/ado/azBoards.ts`
- Test: `packages/core/tests/clients/ado.test.ts`, `packages/core/tests/clients/azBoards.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 beyond the compiled interface.
- Produces:
  - `getWorkItemFields(id: number): Promise<Record<string, unknown> | null>`
  - `listChildren(parentId: number): Promise<number[]>`
  - `addRelation(fromId: number, toId: number, relType: "parent" | "related"): Promise<void>`

- [ ] **Step 1: Add interface methods**

In `packages/core/src/clients/ado/types.ts`, add to `AzureDevOpsClient`:

```ts
  getWorkItemFields(id: number): Promise<Record<string, unknown> | null>;
  listChildren(parentId: number): Promise<number[]>;
  addRelation(fromId: number, toId: number, relType: "parent" | "related"): Promise<void>;
```

- [ ] **Step 2: Write failing tests (both clients)**

Append to `packages/core/tests/clients/ado.test.ts`:

```ts
  it("getWorkItemFields returns the raw fields map", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 5, fields: { "System.Title": "S", "System.WorkItemType": "User Story" } }));
    const f = await new AdoPatClient(cfg).getWorkItemFields(5);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toBe("https://dev.azure.com/acme/Platform/_apis/wit/workitems/5?$expand=fields&api-version=7.1");
    expect(f).toEqual({ "System.Title": "S", "System.WorkItemType": "User Story" });
  });

  it("listChildren queries WIQL by parent and returns ids", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ workItems: [{ id: 11 }, { id: 12 }] }));
    const ids = await new AdoPatClient(cfg).listChildren(9);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.query).toBe("SELECT [System.Id] FROM WorkItems WHERE [System.Parent] = 9 ORDER BY [System.Id]");
    expect(ids).toEqual([11, 12]);
  });

  it("addRelation patches a Hierarchy-Reverse link for a parent", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 3 }));
    await new AdoPatClient(cfg).addRelation(3, 2, "parent");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://dev.azure.com/acme/Platform/_apis/wit/workitems/3?api-version=7.1");
    expect(init.method).toBe("PATCH");
    const ops = JSON.parse(init.body as string);
    expect(ops[0]).toEqual({
      op: "add",
      path: "/relations/-",
      value: { rel: "System.LinkTypes.Hierarchy-Reverse", url: "https://dev.azure.com/acme/_apis/wit/workitems/2" }
    });
  });

  it("addRelation uses System.LinkTypes.Related for a related link", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 3 }));
    await new AdoPatClient(cfg).addRelation(3, 8, "related");
    const ops = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(ops[0].value.rel).toBe("System.LinkTypes.Related");
  });
```

Append to `packages/core/tests/clients/azBoards.test.ts`:

```ts
  it("getWorkItemFields shows the item and returns its fields", async () => {
    const runner = makeRunner(() => ({ id: 5, fields: { "System.Title": "S", "System.WorkItemType": "User Story" } }));
    const f = await new AzBoardsClient(cfg as any, runner as any).getWorkItemFields(5);
    const args = (runner.json as any).mock.calls[0][0] as string[];
    expect(args).toEqual(["boards", "work-item", "show", "--id", "5", "--expand", "fields", "--org", cfg.orgUrl]);
    expect(f).toEqual({ "System.Title": "S", "System.WorkItemType": "User Story" });
  });

  it("listChildren queries by parent and returns ids", async () => {
    const runner = makeRunner(() => [{ id: 11 }, { id: 12 }]);
    const ids = await new AzBoardsClient(cfg as any, runner as any).listChildren(9);
    const wiql = (runner.json as any).mock.calls[0][0][3] as string;
    expect(wiql).toContain("[System.Parent] = 9");
    expect(ids).toEqual([11, 12]);
  });

  it("addRelation shells relation add with the relation type", async () => {
    const runner = makeRunner(() => ({}));
    await new AzBoardsClient(cfg as any, runner as any).addRelation(3, 2, "parent");
    const args = (runner.json as any).mock.calls[0][0] as string[];
    expect(args).toEqual([
      "boards", "work-item", "relation", "add", "--id", "3", "--relation-type", "parent", "--target-id", "2", "--org", cfg.orgUrl
    ]);
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd packages/core && npx vitest run tests/clients/ado.test.ts tests/clients/azBoards.test.ts`
Expected: FAIL — methods not defined.

- [ ] **Step 4: Implement the three primitives (REST)**

In `AdoPatClient` (`packages/core/src/clients/ado/index.ts`):

```ts
  async getWorkItemFields(id: number): Promise<Record<string, unknown> | null> {
    if (!this.cfg.enabled) return null;
    this.assertConfigured();
    if (!Number.isInteger(id)) throw new Error("work item id must be an integer");
    const row = await this.requestJson<AzWorkItemRaw>(
      this.apiUrl(`wit/workitems/${id}?$expand=fields&api-version=7.1`),
      { headers: { Accept: "application/json", Authorization: this.authHeader } }
    );
    return row?.fields ?? null;
  }

  async listChildren(parentId: number): Promise<number[]> {
    if (!this.cfg.enabled) return [];
    this.assertConfigured();
    if (!Number.isInteger(parentId)) throw new Error("parent id must be an integer");
    const query = `SELECT [System.Id] FROM WorkItems WHERE [System.Parent] = ${parentId} ORDER BY [System.Id]`;
    const wiql = await this.requestJson<{ workItems?: Array<{ id: number }> }>(
      this.apiUrl("wit/wiql?api-version=7.1"),
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: this.authHeader },
        body: JSON.stringify({ query })
      }
    );
    return (wiql.workItems ?? []).map((w) => w.id);
  }

  async addRelation(fromId: number, toId: number, relType: "parent" | "related"): Promise<void> {
    if (!this.cfg.enabled) throw new Error("ADO integration is disabled");
    this.assertConfigured();
    const rel = relType === "parent" ? "System.LinkTypes.Hierarchy-Reverse" : "System.LinkTypes.Related";
    const targetUrl = `${this.cfg.orgUrl}/_apis/wit/workitems/${toId}`;
    const ops = [{ op: "add", path: "/relations/-", value: { rel, url: targetUrl } }];
    await this.requestJson<AzWorkItemRaw>(this.apiUrl(`wit/workitems/${fromId}?api-version=7.1`), {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json-patch+json",
        Accept: "application/json",
        Authorization: this.authHeader
      },
      body: JSON.stringify(ops)
    });
  }
```

- [ ] **Step 5: Implement the three primitives (CLI)**

In `AzBoardsClient` (`packages/core/src/clients/ado/azBoards.ts`):

```ts
  async getWorkItemFields(id: number): Promise<Record<string, unknown> | null> {
    if (!Number.isInteger(id)) throw new Error("work item id must be an integer");
    const row = await this.runner.json<AzWorkItemRaw | null>([
      "boards", "work-item", "show", "--id", String(id), "--expand", "fields", "--org", this.cfg.orgUrl
    ]);
    return row?.fields ?? null;
  }

  async listChildren(parentId: number): Promise<number[]> {
    if (!Number.isInteger(parentId)) throw new Error("parent id must be an integer");
    const wiql = `SELECT [System.Id] FROM workitems WHERE [System.Parent] = ${parentId} ORDER BY [System.Id]`;
    const rows = await this.runner.json<Array<{ id: number }>>([
      "boards", "query", "--wiql", wiql, "--org", this.cfg.orgUrl, "--project", this.cfg.project
    ]);
    return (rows ?? []).map((r) => r.id);
  }

  async addRelation(fromId: number, toId: number, relType: "parent" | "related"): Promise<void> {
    await this.runner.json([
      "boards", "work-item", "relation", "add",
      "--id", String(fromId), "--relation-type", relType, "--target-id", String(toId), "--org", this.cfg.orgUrl
    ]);
  }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd packages/core && npx vitest run tests/clients/ado.test.ts tests/clients/azBoards.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/clients/ado/types.ts packages/core/src/clients/ado/index.ts packages/core/src/clients/ado/azBoards.ts packages/core/tests/clients/ado.test.ts packages/core/tests/clients/azBoards.test.ts
git commit -m "feat(ado): add getWorkItemFields, listChildren, addRelation primitives"
```

---

### Task 3: Config — `ADO_BOARD_MAP` → `boardMap`

**Files:**
- Modify: `packages/core/src/config.ts`
- Test: `packages/core/tests/config.test.ts` (create if absent)

**Interfaces:**
- Produces: `AdoConfig.boardMap?: Record<string, string>`.

- [ ] **Step 1: Write the failing test**

Create/append `packages/core/tests/config.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

const base = {
  SERVICENOW_BASE_URL: "https://sn.example.com",
  SERVICENOW_USERNAME: "u",
  SERVICENOW_PASSWORD: "p"
};

describe("loadConfig ADO_BOARD_MAP", () => {
  it("parses a JSON board map", () => {
    const c = loadConfig({ ...base, ADO_BOARD_MAP: '{"Team Alpha":"Platform\\\\Alpha"}' });
    expect(c.azureDevOps.boardMap).toEqual({ "Team Alpha": "Platform\\Alpha" });
  });

  it("defaults to an empty map when unset", () => {
    const c = loadConfig({ ...base });
    expect(c.azureDevOps.boardMap).toEqual({});
  });

  it("ignores invalid JSON without throwing", () => {
    const c = loadConfig({ ...base, ADO_BOARD_MAP: "{not json" });
    expect(c.azureDevOps.boardMap).toEqual({});
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/core && npx vitest run tests/config.test.ts`
Expected: FAIL — `boardMap` is undefined.

- [ ] **Step 3: Implement**

In `packages/core/src/config.ts`:

Add to `envSchema` (near the other `ADO_*` lines):

```ts
  ADO_BOARD_MAP: z.string().optional(),
```

Add to the `AdoConfig` interface:

```ts
  boardMap?: Record<string, string>;
```

Add a parser helper near `csv`/`hostOf`:

```ts
const parseBoardMap = (raw?: string): Record<string, string> => {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>).filter(([, val]) => typeof val === "string") as [string, string][]
      );
    }
  } catch {
    // ponytail: invalid board map JSON is ignored, not fatal — never block startup
  }
  return {};
};
```

In the returned `azureDevOps` object, add:

```ts
      boardMap: parseBoardMap(e.ADO_BOARD_MAP),
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/core && npx vitest run tests/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/config.ts packages/core/tests/config.test.ts
git commit -m "feat(config): parse ADO_BOARD_MAP into azureDevOps.boardMap"
```

---

### Task 4: `WorkItemService.create` + `resolveAreaPath`

**Files:**
- Create: `packages/core/src/services/workItemService.ts`
- Test: `packages/core/tests/services/workItemService.test.ts`

**Interfaces:**
- Consumes: `AzureDevOpsClient` (`createWorkItem`, `addRelation`); `AdoConfig.boardMap`, `defaultAreaPath`, `defaultIterationPath`.
- Produces:
  - `WorkItemServiceConfig { boardMap: Record<string,string>; defaultAreaPath?: string; defaultIterationPath?: string }`
  - `CreateWorkItemInput` (below)
  - `class WorkItemService { constructor(client, cfg); resolveAreaPath(board?, areaPath?): string | undefined; create(input: CreateWorkItemInput): Promise<WorkItem>; }`

- [ ] **Step 1: Write the failing tests**

Create `packages/core/tests/services/workItemService.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { WorkItemService } from "../../src/services/workItemService.js";

const makeClient = (over: Partial<Record<string, any>> = {}) => ({
  createWorkItem: vi.fn(async (p: any) => ({ id: 100, title: p.title, state: "New", workItemType: p.type, areaPath: p.areaPath })),
  addRelation: vi.fn(async () => {}),
  getWorkItemFields: vi.fn(async () => null),
  listChildren: vi.fn(async () => []),
  searchWorkItems: vi.fn(),
  getWorkItem: vi.fn(),
  createBug: vi.fn(),
  ...over
});

const cfg = { boardMap: { "Team Alpha": "Platform\\Alpha" }, defaultAreaPath: "Platform", defaultIterationPath: "Platform\\S1" };

describe("WorkItemService.resolveAreaPath", () => {
  it("prefers explicit areaPath over board and default", () => {
    const svc = new WorkItemService(makeClient() as any, cfg);
    expect(svc.resolveAreaPath("Team Alpha", "Explicit\\Path")).toBe("Explicit\\Path");
  });
  it("maps a known board name", () => {
    const svc = new WorkItemService(makeClient() as any, cfg);
    expect(svc.resolveAreaPath("Team Alpha")).toBe("Platform\\Alpha");
  });
  it("falls back to defaultAreaPath for an unknown board", () => {
    const svc = new WorkItemService(makeClient() as any, cfg);
    expect(svc.resolveAreaPath("Nope")).toBe("Platform");
  });
});

describe("WorkItemService.create", () => {
  it("creates with the resolved area path", async () => {
    const client = makeClient();
    const svc = new WorkItemService(client as any, cfg);
    await svc.create({ type: "User Story", title: "S", board: "Team Alpha" });
    expect(client.createWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({ type: "User Story", title: "S", areaPath: "Platform\\Alpha", iterationPath: "Platform\\S1" })
    );
  });

  it("links the new item to a parent when parentId is set", async () => {
    const client = makeClient({ createWorkItem: vi.fn(async () => ({ id: 200, title: "T", state: "New" })) });
    const svc = new WorkItemService(client as any, cfg);
    await svc.create({ type: "Task", title: "T", parentId: 42 });
    expect(client.addRelation).toHaveBeenCalledWith(200, 42, "parent");
  });

  it("does not link when parentId is absent", async () => {
    const client = makeClient();
    const svc = new WorkItemService(client as any, cfg);
    await svc.create({ type: "Task", title: "T" });
    expect(client.addRelation).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/core && npx vitest run tests/services/workItemService.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the service (create half)**

Create `packages/core/src/services/workItemService.ts`:

```ts
import type { WorkItem } from "../types.js";
import type { AzureDevOpsClient, CreateWorkItemPayload } from "../clients/ado/types.js";

export interface WorkItemServiceConfig {
  boardMap: Record<string, string>;
  defaultAreaPath?: string;
  defaultIterationPath?: string;
}

export interface CreateWorkItemInput {
  type: string;
  title: string;
  description?: string;
  board?: string;
  areaPath?: string;
  iterationPath?: string;
  tags?: string[];
  assignedTo?: string;
  priority?: string;
  storyPoints?: number;
  parentId?: number;
}

export class WorkItemService {
  constructor(
    private readonly client: AzureDevOpsClient,
    private readonly cfg: WorkItemServiceConfig
  ) {}

  resolveAreaPath(board?: string, areaPath?: string): string | undefined {
    if (areaPath) return areaPath;
    if (board && this.cfg.boardMap[board]) return this.cfg.boardMap[board];
    return this.cfg.defaultAreaPath;
  }

  async create(input: CreateWorkItemInput): Promise<WorkItem> {
    const payload: CreateWorkItemPayload = {
      type: input.type,
      title: input.title,
      description: input.description,
      areaPath: this.resolveAreaPath(input.board, input.areaPath),
      iterationPath: input.iterationPath ?? this.cfg.defaultIterationPath,
      tags: input.tags,
      assignedTo: input.assignedTo,
      priority: input.priority,
      storyPoints: input.storyPoints
    };
    const wi = await this.client.createWorkItem(payload);
    if (input.parentId) await this.client.addRelation(wi.id, input.parentId, "parent");
    return wi;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/core && npx vitest run tests/services/workItemService.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/services/workItemService.ts packages/core/tests/services/workItemService.test.ts
git commit -m "feat(core): add WorkItemService.create with board resolution + parent link"
```

---

### Task 5: `WorkItemService.clone`

**Files:**
- Modify: `packages/core/src/services/workItemService.ts`
- Test: `packages/core/tests/services/workItemService.test.ts`

**Interfaces:**
- Consumes: `AzureDevOpsClient` (`getWorkItemFields`, `listChildren`, `createWorkItem`, `addRelation`); `resolveAreaPath` from Task 4.
- Produces:
  - `CloneWorkItemInput { sourceId: number; board?: string; areaPath?: string; iterationPath?: string; includeChildren?: boolean; linkToSource?: boolean; titlePrefix?: string; overrides?: Partial<CreateWorkItemInput> }`
  - `CloneResult { cloneId: number; sourceId: number; childrenCopied: number; linked: boolean }`
  - `WorkItemService.clone(input: CloneWorkItemInput): Promise<CloneResult>`

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/tests/services/workItemService.test.ts` (the `WorkItemService` import and `makeClient`/`cfg` helpers from Task 4 are already at the top of this file — reuse them, do not re-import):

```ts
const sourceFields = {
  "System.Title": "Add SSO",
  "System.WorkItemType": "User Story",
  "System.Description": "Body <br> here",
  "System.Tags": "auth; security",
  "Microsoft.VSTS.Common.Priority": 2,
  "Microsoft.VSTS.Scheduling.StoryPoints": 5,
  "System.State": "Active",
  "System.AssignedTo": { uniqueName: "orig@x.com" }
};

describe("WorkItemService.clone", () => {
  it("clones fields to the target board, resets state/assignee", async () => {
    const client = makeClient({
      getWorkItemFields: vi.fn(async () => sourceFields),
      createWorkItem: vi.fn(async (p: any) => ({ id: 900, title: p.title, state: "New" }))
    });
    const svc = new WorkItemService(client as any, cfg);
    const res = await svc.clone({ sourceId: 1234, board: "Team Alpha" });

    const payload = (client.createWorkItem as any).mock.calls[0][0];
    expect(payload.type).toBe("User Story");
    expect(payload.title).toBe("Add SSO");
    expect(payload.areaPath).toBe("Platform\\Alpha");
    expect(payload.tags).toEqual(["auth", "security"]);
    expect(payload.priority).toBe("2");
    expect(payload.storyPoints).toBe(5);
    expect(payload.assignedTo).toBeUndefined(); // cleared
    expect(payload.fields["System.Description"]).toBe("Body <br> here"); // raw, no re-conversion
    expect(res).toEqual({ cloneId: 900, sourceId: 1234, childrenCopied: 0, linked: false });
  });

  it("applies a title prefix and overrides", async () => {
    const client = makeClient({ getWorkItemFields: vi.fn(async () => sourceFields) });
    const svc = new WorkItemService(client as any, cfg);
    await svc.clone({ sourceId: 1, board: "Team Alpha", titlePrefix: "[CLONE] ", overrides: { priority: "1", tags: ["x"] } });
    const payload = (client.createWorkItem as any).mock.calls[0][0];
    expect(payload.title).toBe("[CLONE] Add SSO");
    expect(payload.priority).toBe("1");
    expect(payload.tags).toEqual(["x"]);
  });

  it("copies children and links them to the clone when includeChildren is set", async () => {
    const childFields = { "System.Title": "Subtask", "System.WorkItemType": "Task", "System.Description": "do it" };
    const client = makeClient({
      getWorkItemFields: vi.fn(async (id: number) => (id === 1 ? sourceFields : childFields)),
      listChildren: vi.fn(async () => [55]),
      createWorkItem: vi.fn(async (p: any) => ({ id: p.type === "Task" ? 901 : 900, title: p.title, state: "New" }))
    });
    const svc = new WorkItemService(client as any, cfg);
    const res = await svc.clone({ sourceId: 1, board: "Team Alpha", includeChildren: true });
    expect(client.listChildren).toHaveBeenCalledWith(1);
    expect(client.addRelation).toHaveBeenCalledWith(901, 900, "parent"); // child linked under clone
    expect(res.childrenCopied).toBe(1);
  });

  it("adds a related link back to the source when linkToSource is set", async () => {
    const client = makeClient({
      getWorkItemFields: vi.fn(async () => sourceFields),
      createWorkItem: vi.fn(async () => ({ id: 900, title: "Add SSO", state: "New" }))
    });
    const svc = new WorkItemService(client as any, cfg);
    const res = await svc.clone({ sourceId: 1234, board: "Team Alpha", linkToSource: true });
    expect(client.addRelation).toHaveBeenCalledWith(900, 1234, "related");
    expect(res.linked).toBe(true);
  });

  it("throws when the source is not found", async () => {
    const client = makeClient({ getWorkItemFields: vi.fn(async () => null) });
    const svc = new WorkItemService(client as any, cfg);
    await expect(svc.clone({ sourceId: 999 })).rejects.toThrow(/999.*not found/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/core && npx vitest run tests/services/workItemService.test.ts`
Expected: FAIL — `clone` not defined.

- [ ] **Step 3: Implement `clone`**

Add the types and method to `packages/core/src/services/workItemService.ts`.

Add after `CreateWorkItemInput`:

```ts
export interface CloneWorkItemInput {
  sourceId: number;
  board?: string;
  areaPath?: string;
  iterationPath?: string;
  includeChildren?: boolean;
  linkToSource?: boolean;
  titlePrefix?: string;
  overrides?: Partial<CreateWorkItemInput>;
}

export interface CloneResult {
  cloneId: number;
  sourceId: number;
  childrenCopied: number;
  linked: boolean;
}
```

Add these private helpers and the `clone` method inside the class:

```ts
  private parseTags(raw: unknown): string[] | undefined {
    if (typeof raw !== "string" || !raw.trim()) return undefined;
    return raw.split(/;\s*/).map((t) => t.trim()).filter(Boolean);
  }

  // Build a CreateWorkItemPayload from a source item's raw fields. Description and
  // acceptance criteria are carried as raw HTML via `fields` (not `description`)
  // so createWorkItem does not re-run the \n->"<br>" conversion on already-HTML text.
  private payloadFromFields(
    fields: Record<string, unknown>,
    areaPath: string | undefined,
    iterationPath: string | undefined,
    titlePrefix = ""
  ): CreateWorkItemPayload {
    const type = String(fields["System.WorkItemType"] ?? "Task");
    const rawFields: Record<string, string> = {};
    const desc = fields["System.Description"] ?? fields["Microsoft.VSTS.TCM.ReproSteps"];
    if (typeof desc === "string" && desc) {
      rawFields[type === "Bug" ? "Microsoft.VSTS.TCM.ReproSteps" : "System.Description"] = desc;
    }
    const ac = fields["Microsoft.VSTS.Common.AcceptanceCriteria"];
    if (typeof ac === "string" && ac) rawFields["Microsoft.VSTS.Common.AcceptanceCriteria"] = ac;
    const prio = fields["Microsoft.VSTS.Common.Priority"];
    const sp = fields["Microsoft.VSTS.Scheduling.StoryPoints"];
    return {
      type,
      title: titlePrefix + String(fields["System.Title"] ?? ""),
      areaPath,
      iterationPath,
      tags: this.parseTags(fields["System.Tags"]),
      priority: typeof prio === "number" ? String(prio) : undefined,
      storyPoints: typeof sp === "number" ? sp : undefined,
      // state reset (omit) and assignedTo cleared (omit) by design
      fields: Object.keys(rawFields).length ? rawFields : undefined
    };
  }

  async clone(input: CloneWorkItemInput): Promise<CloneResult> {
    const fields = await this.client.getWorkItemFields(input.sourceId);
    if (!fields) throw new Error(`source work item ${input.sourceId} not found`);

    const areaPath = this.resolveAreaPath(input.board, input.areaPath);
    const iterationPath = input.iterationPath ?? this.cfg.defaultIterationPath;

    const base = this.payloadFromFields(fields, areaPath, iterationPath, input.titlePrefix ?? "");
    const o = input.overrides ?? {};
    const payload: CreateWorkItemPayload = {
      ...base,
      ...(o.type !== undefined ? { type: o.type } : {}),
      ...(o.title !== undefined ? { title: o.title } : {}),
      ...(o.description !== undefined ? { description: o.description } : {}),
      ...(o.tags !== undefined ? { tags: o.tags } : {}),
      ...(o.assignedTo !== undefined ? { assignedTo: o.assignedTo } : {}),
      ...(o.priority !== undefined ? { priority: o.priority } : {}),
      ...(o.storyPoints !== undefined ? { storyPoints: o.storyPoints } : {})
    };

    const clone = await this.client.createWorkItem(payload);

    let childrenCopied = 0;
    if (input.includeChildren) {
      const children = await this.client.listChildren(input.sourceId);
      for (const childId of children) {
        const cf = await this.client.getWorkItemFields(childId);
        if (!cf) continue;
        const childPayload = this.payloadFromFields(cf, areaPath, iterationPath);
        const created = await this.client.createWorkItem(childPayload);
        await this.client.addRelation(created.id, clone.id, "parent");
        childrenCopied++;
      }
    }

    if (input.linkToSource) await this.client.addRelation(clone.id, input.sourceId, "related");

    return { cloneId: clone.id, sourceId: input.sourceId, childrenCopied, linked: !!input.linkToSource };
  }
```

Ensure `CreateWorkItemPayload` is imported (it already is from Task 4's import line).

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/core && npx vitest run tests/services/workItemService.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/services/workItemService.ts packages/core/tests/services/workItemService.test.ts
git commit -m "feat(core): add WorkItemService.clone with children + backlink"
```

---

### Task 6: Runtime wiring + core exports

**Files:**
- Modify: `packages/core/src/runtime.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/tests/runtime.test.ts` (create if absent)

**Interfaces:**
- Consumes: `WorkItemService` (Task 4/5), `config.azureDevOps.boardMap` (Task 3).
- Produces: `McpRuntime.workItemService: WorkItemService`; `export * from "./services/workItemService.js"`.

- [ ] **Step 1: Write the failing test**

Create/append `packages/core/tests/runtime.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { createMcpRuntime } from "../src/runtime.js";

const env = {
  SERVICENOW_BASE_URL: "https://sn.example.com",
  SERVICENOW_USERNAME: "u",
  SERVICENOW_PASSWORD: "p"
};

describe("createMcpRuntime", () => {
  it("exposes a workItemService", () => {
    const rt = createMcpRuntime(env);
    expect(rt.workItemService).toBeDefined();
    expect(typeof rt.workItemService.create).toBe("function");
    expect(typeof rt.workItemService.clone).toBe("function");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/core && npx vitest run tests/runtime.test.ts`
Expected: FAIL — `workItemService` undefined.

- [ ] **Step 3: Implement wiring**

In `packages/core/src/runtime.ts`:

Add import:

```ts
import { WorkItemService } from "./services/workItemService.js";
```

Add to the `McpRuntime` interface:

```ts
  workItemService: WorkItemService;
```

Construct it after `azureDevOpsClient` is created:

```ts
  const workItemService = new WorkItemService(azureDevOpsClient, {
    boardMap: config.azureDevOps.boardMap ?? {},
    defaultAreaPath: config.azureDevOps.defaultAreaPath,
    defaultIterationPath: config.azureDevOps.defaultIterationPath
  });
```

Add `workItemService` to the returned object.

In `packages/core/src/index.ts`, add:

```ts
export * from "./services/workItemService.js";
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/core && npx vitest run tests/runtime.test.ts && npm run build`
Expected: PASS and a clean build.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/runtime.ts packages/core/src/index.ts packages/core/tests/runtime.test.ts
git commit -m "feat(core): expose workItemService on the runtime"
```

---

### Task 7: MCP tools `create_work_item` + `clone_work_item`

**Files:**
- Modify: `packages/mcp-server/src/tools/ado.ts`
- Modify: `packages/mcp-server/src/server.ts` (no new registrar needed — same file), `packages/mcp-server/src/tools/index.ts` (no change; `registerAdoTools` already exported)

**Interfaces:**
- Consumes: `runtime.workItemService.create` / `.clone`; `runtime.config.azureDevOps.enabled`.

- [ ] **Step 1: Add the two tools**

In `packages/mcp-server/src/tools/ado.ts`, inside `registerAdoTools`, after the existing tools, add:

```ts
  // create_work_item - Create any ADO work item type on a board/backlog
  server.tool(
    "create_work_item",
    "Create an Azure DevOps work item (User Story, Task, Bug, Feature, Epic, Issue) on a board/backlog. Target the board via `board` (friendly name, resolved to an area path) or an explicit `area_path`. Optionally link under a parent work item.",
    {
      type: z.enum(["User Story", "Task", "Bug", "Feature", "Epic", "Issue"]).describe("Work item type"),
      title: z.string().describe("Work item title"),
      description: z.string().optional().describe("Body/description"),
      board: z.string().optional().describe("Friendly board/team name, resolved to an area path via config"),
      area_path: z.string().optional().describe("Explicit ADO area path (overrides board)"),
      iteration_path: z.string().optional().describe("ADO iteration/sprint path"),
      tags: z.array(z.string()).optional().describe("Tags"),
      assigned_to: z.string().optional().describe("Assignee email/display name"),
      priority: z.enum(["1", "2", "3", "4"]).optional().describe("Priority 1 (highest) - 4"),
      story_points: z.number().optional().describe("Story points"),
      parent_id: z.number().optional().describe("Existing work item id to link this under (parent)")
    },
    async (args) => {
      try {
        if (!runtime.config.azureDevOps.enabled) {
          return { content: [{ type: "text", text: "Azure DevOps integration is disabled. Set ADO_ENABLED=true." }], isError: true };
        }
        const wi = await runtime.workItemService.create({
          type: args.type,
          title: args.title,
          description: args.description,
          board: args.board,
          areaPath: args.area_path,
          iterationPath: args.iteration_path,
          tags: args.tags,
          assignedTo: args.assigned_to,
          priority: args.priority,
          storyPoints: args.story_points,
          parentId: args.parent_id
        });
        return { content: [{ type: "text", text: JSON.stringify({ success: true, id: wi.id, title: wi.title, type: wi.workItemType, areaPath: wi.areaPath, parentId: args.parent_id }, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error creating work item: ${error}` }], isError: true };
      }
    }
  );

  // clone_work_item - Clone a work item to another board
  server.tool(
    "clone_work_item",
    "Clone an existing Azure DevOps work item to another board. Carries over fields (title, description, tags, priority, story points, acceptance criteria), resets state to New and clears the assignee. Optionally copies child tasks and adds a Related link back to the source.",
    {
      source_id: z.number().describe("Work item id to clone"),
      board: z.string().optional().describe("Target board/team name, resolved to an area path"),
      area_path: z.string().optional().describe("Explicit target area path (overrides board)"),
      iteration_path: z.string().optional().describe("Target iteration/sprint path"),
      include_children: z.boolean().optional().describe("Copy child tasks too (default false)"),
      link_to_source: z.boolean().optional().describe("Add a Related link back to the source (default false)"),
      title_prefix: z.string().optional().describe("Prefix prepended to the cloned title (e.g. '[CLONE] ')"),
      overrides: z
        .object({
          title: z.string().optional(),
          description: z.string().optional(),
          tags: z.array(z.string()).optional(),
          assigned_to: z.string().optional(),
          priority: z.enum(["1", "2", "3", "4"]).optional(),
          story_points: z.number().optional()
        })
        .optional()
        .describe("Field overrides applied on top of the carried-over source fields")
    },
    async (args) => {
      try {
        if (!runtime.config.azureDevOps.enabled) {
          return { content: [{ type: "text", text: "Azure DevOps integration is disabled. Set ADO_ENABLED=true." }], isError: true };
        }
        const o = args.overrides;
        const res = await runtime.workItemService.clone({
          sourceId: args.source_id,
          board: args.board,
          areaPath: args.area_path,
          iterationPath: args.iteration_path,
          includeChildren: args.include_children,
          linkToSource: args.link_to_source,
          titlePrefix: args.title_prefix,
          overrides: o
            ? {
                type: undefined,
                title: o.title,
                description: o.description,
                tags: o.tags,
                assignedTo: o.assigned_to,
                priority: o.priority,
                storyPoints: o.story_points
              }
            : undefined
        });
        return { content: [{ type: "text", text: JSON.stringify({ success: true, ...res }, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error cloning work item: ${error}` }], isError: true };
      }
    }
  );
```

- [ ] **Step 2: Build the mcp-server package**

Run: `cd packages/mcp-server && npm run build`
Expected: clean build (no type errors). This is the verification gate for these thin passthrough tools.

- [ ] **Step 3: Commit**

```bash
git add packages/mcp-server/src/tools/ado.ts
git commit -m "feat(mcp): add create_work_item and clone_work_item tools"
```

---

## Phase 2 — CSV folder ingestion

### Task 8: `csv-parse` dependency + `csvReader` module

**Files:**
- Modify: `packages/core/package.json` (add dependency)
- Create: `packages/core/src/services/csvReader.ts`
- Modify: `packages/core/src/index.ts` (export)
- Test: `packages/core/tests/services/csvReader.test.ts`

**Interfaces:**
- Produces:
  - `CsvTable { headers: string[]; rows: Record<string,string>[]; rowCount: number }`
  - `CsvFileInfo { name: string; sizeBytes: number; modified: string }`
  - `listCsvFiles(dir: string): Promise<CsvFileInfo[]>`
  - `readCsvFile(dir: string, filename: string, maxBytes: number): Promise<CsvTable>`

- [ ] **Step 1: Add the dependency**

In `packages/core/package.json`, add to `dependencies`:

```json
    "csv-parse": "^5.5.6",
```

Run: `npm install` (from repo root) to install into the workspace.

- [ ] **Step 2: Write the failing tests**

Create `packages/core/tests/services/csvReader.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listCsvFiles, readCsvFile } from "../../src/services/csvReader.js";

let dir: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "csvreader-"));
  await fs.writeFile(join(dir, "stories.csv"), 'type,title,description\nUser Story,"Add, SSO","line1\nline2"\nTask,Wire OIDC,do it\n');
  await fs.writeFile(join(dir, "notes.txt"), "ignore me");
});
afterAll(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe("listCsvFiles", () => {
  it("lists only .csv files with metadata", async () => {
    const files = await listCsvFiles(dir);
    expect(files.map((f) => f.name)).toEqual(["stories.csv"]);
    expect(files[0].sizeBytes).toBeGreaterThan(0);
    expect(typeof files[0].modified).toBe("string");
  });
});

describe("readCsvFile", () => {
  it("parses headers and rows, handling quoted commas and embedded newlines", async () => {
    const table = await readCsvFile(dir, "stories.csv", 1_000_000);
    expect(table.headers).toEqual(["type", "title", "description"]);
    expect(table.rowCount).toBe(2);
    expect(table.rows[0]).toEqual({ type: "User Story", title: "Add, SSO", description: "line1\nline2" });
    expect(table.rows[1].title).toBe("Wire OIDC");
  });

  it("rejects a filename with a path separator", async () => {
    await expect(readCsvFile(dir, "../secret.csv", 1_000_000)).rejects.toThrow(/invalid filename/);
    await expect(readCsvFile(dir, "sub/stories.csv", 1_000_000)).rejects.toThrow(/invalid filename/);
  });

  it("rejects an absolute path", async () => {
    await expect(readCsvFile(dir, "/etc/passwd", 1_000_000)).rejects.toThrow(/invalid filename|only .csv/);
  });

  it("rejects a non-.csv extension", async () => {
    await expect(readCsvFile(dir, "notes.txt", 1_000_000)).rejects.toThrow(/only .csv/);
  });

  it("rejects a file larger than maxBytes", async () => {
    await expect(readCsvFile(dir, "stories.csv", 5)).rejects.toThrow(/exceeds/);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd packages/core && npx vitest run tests/services/csvReader.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement `csvReader`**

Create `packages/core/src/services/csvReader.ts`:

```ts
import { promises as fs } from "node:fs";
import { resolve, sep, extname, basename } from "node:path";
import { parse } from "csv-parse/sync";

export interface CsvTable {
  headers: string[];
  rows: Record<string, string>[];
  rowCount: number;
}

export interface CsvFileInfo {
  name: string;
  sizeBytes: number;
  modified: string; // ISO 8601
}

export const listCsvFiles = async (dir: string): Promise<CsvFileInfo[]> => {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: CsvFileInfo[] = [];
  for (const e of entries) {
    if (!e.isFile() || extname(e.name).toLowerCase() !== ".csv") continue;
    const st = await fs.stat(resolve(dir, e.name));
    out.push({ name: e.name, sizeBytes: st.size, modified: st.mtime.toISOString() });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
};

export const readCsvFile = async (dir: string, filename: string, maxBytes: number): Promise<CsvTable> => {
  // Trust boundary: the filename comes from a tool caller. Reject anything that
  // is not a bare filename in `dir`, then confirm the resolved path stays inside.
  if (filename !== basename(filename) || filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
    throw new Error(`invalid filename: ${filename}`);
  }
  if (extname(filename).toLowerCase() !== ".csv") throw new Error("only .csv files are allowed");
  const base = resolve(dir);
  const full = resolve(base, filename);
  if (full !== `${base}${sep}${filename}` && !full.startsWith(`${base}${sep}`)) {
    throw new Error("path escapes the CSV directory");
  }
  const st = await fs.stat(full);
  if (st.size > maxBytes) throw new Error(`file exceeds ${maxBytes} bytes`);

  const text = await fs.readFile(full, "utf8");
  const matrix = parse(text, { skip_empty_lines: true, trim: true }) as string[][];
  if (!matrix.length) return { headers: [], rows: [], rowCount: 0 };
  const headers = matrix[0];
  const rows = matrix.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""])));
  return { headers, rows, rowCount: rows.length };
};
```

Add to `packages/core/src/index.ts`:

```ts
export * from "./services/csvReader.js";
```

- [ ] **Step 5: Run to verify it passes**

Run: `cd packages/core && npx vitest run tests/services/csvReader.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/package.json package-lock.json packages/core/src/services/csvReader.ts packages/core/src/index.ts packages/core/tests/services/csvReader.test.ts
git commit -m "feat(core): add csvReader (list + parse) with a path-traversal guard"
```

---

### Task 9: Config — `ADO_CSV_DIR` + `ADO_CSV_MAX_BYTES`

**Files:**
- Modify: `packages/core/src/config.ts`
- Test: `packages/core/tests/config.test.ts`

**Interfaces:**
- Produces: `AdoConfig.csvDir?: string`, `AdoConfig.csvMaxBytes: number`.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/tests/config.test.ts`:

```ts
describe("loadConfig ADO_CSV_DIR", () => {
  it("passes through csvDir and defaults csvMaxBytes", () => {
    const c = loadConfig({ ...base, ADO_CSV_DIR: "/data/csvs" });
    expect(c.azureDevOps.csvDir).toBe("/data/csvs");
    expect(c.azureDevOps.csvMaxBytes).toBe(5242880);
  });
  it("leaves csvDir undefined when unset", () => {
    const c = loadConfig({ ...base });
    expect(c.azureDevOps.csvDir).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/core && npx vitest run tests/config.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `packages/core/src/config.ts`:

Add to `envSchema`:

```ts
  ADO_CSV_DIR: optional(z.string().min(1)),
  ADO_CSV_MAX_BYTES: z.coerce.number().int().positive().default(5242880),
```

Add to the `AdoConfig` interface:

```ts
  csvDir?: string;
  csvMaxBytes: number;
```

Add to the returned `azureDevOps` object:

```ts
      csvDir: e.ADO_CSV_DIR,
      csvMaxBytes: e.ADO_CSV_MAX_BYTES,
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd packages/core && npx vitest run tests/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/config.ts packages/core/tests/config.test.ts
git commit -m "feat(config): add ADO_CSV_DIR and ADO_CSV_MAX_BYTES"
```

---

### Task 10: CSV MCP tools + wiring

**Files:**
- Create: `packages/mcp-server/src/tools/workItemCsv.ts`
- Modify: `packages/mcp-server/src/tools/index.ts`, `packages/mcp-server/src/server.ts`

**Interfaces:**
- Consumes: `listCsvFiles`, `readCsvFile` from `@sre/core`; `runtime.config.azureDevOps.{enabled,csvDir,csvMaxBytes}`.
- Produces: `registerWorkItemCsvTools(server, runtime)`.

- [ ] **Step 1: Create the tools module**

Create `packages/mcp-server/src/tools/workItemCsv.ts`:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { McpRuntime, listCsvFiles, readCsvFile } from "@sre/core";

export const registerWorkItemCsvTools = (server: McpServer, runtime: McpRuntime): void => {
  const csvDir = () => runtime.config.azureDevOps.csvDir;

  const guard = (): { type: "text"; text: string } | null => {
    if (!runtime.config.azureDevOps.enabled) return { type: "text", text: "Azure DevOps integration is disabled. Set ADO_ENABLED=true." };
    if (!csvDir()) return { type: "text", text: "CSV folder not configured. Set ADO_CSV_DIR to a folder of .csv files." };
    return null;
  };

  server.tool(
    "list_work_item_csvs",
    "List CSV files available in the configured work-item CSV folder (ADO_CSV_DIR). Use read_work_item_csv to load one, then create_work_item / clone_work_item per row.",
    {},
    async () => {
      const g = guard();
      if (g) return { content: [g], isError: true };
      try {
        const files = await listCsvFiles(csvDir() as string);
        return { content: [{ type: "text", text: JSON.stringify({ files }, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error listing CSV files: ${error}` }], isError: true };
      }
    }
  );

  server.tool(
    "read_work_item_csv",
    "Read a CSV file from the configured folder (ADO_CSV_DIR) and return its headers and rows as structured JSON. Then detect which rows are stories/tasks and call create_work_item / clone_work_item per row.",
    { filename: z.string().describe("CSV filename within ADO_CSV_DIR (no path separators)") },
    async (args) => {
      const g = guard();
      if (g) return { content: [g], isError: true };
      try {
        const table = await readCsvFile(csvDir() as string, args.filename, runtime.config.azureDevOps.csvMaxBytes);
        return { content: [{ type: "text", text: JSON.stringify(table, null, 2) }] };
      } catch (error) {
        return { content: [{ type: "text", text: `Error reading CSV: ${error}` }], isError: true };
      }
    }
  );
};
```

- [ ] **Step 2: Wire the registrar**

In `packages/mcp-server/src/tools/index.ts`, add:

```ts
export { registerWorkItemCsvTools } from "./workItemCsv.js";
```

In `packages/mcp-server/src/server.ts`, add the import:

```ts
import { registerWorkItemCsvTools } from "./tools/workItemCsv.js";
```

And call it alongside the other tool registrars (after `registerAdoTools(server, runtime);`):

```ts
  registerWorkItemCsvTools(server, runtime);
```

- [ ] **Step 3: Build the mcp-server package**

Run: `cd packages/mcp-server && npm run build`
Expected: clean build.

- [ ] **Step 4: Commit**

```bash
git add packages/mcp-server/src/tools/workItemCsv.ts packages/mcp-server/src/tools/index.ts packages/mcp-server/src/server.ts
git commit -m "feat(mcp): add list_work_item_csvs and read_work_item_csv tools"
```

---

### Task 11: Ship the CSV template + end-to-end smoke check

**Files:**
- Create: `templates/work-items.csv`

- [ ] **Step 1: Create the template**

Create `templates/work-items.csv` with exactly:

```csv
action,ref,type,title,description,board,area_path,iteration_path,tags,assigned_to,priority,story_points,parent_id,parent_ref,source_id,include_children,link_to_source
create,S1,User Story,Add SSO login,Users can sign in via corporate SSO,Team Alpha,,,auth;security,,2,5,,,,,
create,,Task,Wire up OIDC client,Configure the OIDC redirect + token exchange,Team Alpha,,,auth,,2,,,S1,,,
clone,,,,,Team Beta,,,,,,,,,1234,true,true
```

- [ ] **Step 2: Full test suite + build gate**

Run: `cd packages/core && npm test && npm run build`
Expected: all core tests PASS, clean build.

Run: `cd packages/mcp-server && npm run build`
Expected: clean build.

- [ ] **Step 3: Manual smoke check (documented, requires a real ADO org)**

This is a manual verification note, not an automated test. With `ADO_ENABLED=true`, a valid PAT (or azcli via the sre-agent), `ADO_BOARD_MAP` mapping the template's board names to real area paths, and `ADO_CSV_DIR` pointing at `templates/`:

1. Call `list_work_item_csvs` → expect `work-items.csv` in the list.
2. Call `read_work_item_csv` with `work-items.csv` → expect 3 rows with the 17 headers.
3. Call `create_work_item` with `{type:"User Story", title:"smoke", board:"<a mapped board>"}` → expect a real work item id back; verify it lands on the expected board in ADO.
4. Call `clone_work_item` with a real `source_id` and a target `board` → verify the clone appears on the target board.

- [ ] **Step 4: Commit**

```bash
git add templates/work-items.csv
git commit -m "feat: ship work-items.csv template for CSV-driven creation"
```

---

## Self-Review

**Spec coverage:**
- Generalized create (all types) → Tasks 1, 7. ✅
- Board targeting (explicit path + board-name map) → Tasks 3, 4, 7. ✅
- Parent linking (task→story) → Tasks 2, 4, 7 (`parent_id`). ✅
- Clone with per-call flags (`include_children`, `link_to_source`) → Tasks 2, 5, 7. ✅
- Clone field defaults (carry-over, reset state, clear assignee, overrides) → Task 5. ✅
- `createBug` delegates to `createWorkItem` → Task 1. ✅
- CSV folder + `ADO_CSV_DIR` + structured read + path guard → Tasks 8, 9, 10. ✅
- CSV template shipped → Task 11. ✅
- `csv-parse` dependency → Task 8. ✅
- Both clients implement every primitive → Tasks 1, 2. ✅
- Runtime exposes the service → Task 6. ✅
- Testing (client, service, csvReader, config) → Tasks 1, 2, 3, 4, 5, 8, 9. ✅

**Deferred (spec "out of scope"), intentionally no task:** ADO Teams-API name resolution, server-side bulk-from-CSV tool, `get_csv_template` tool, cross-project clone, edit/delete.

**Type consistency:** `CreateWorkItemPayload` (client) vs `CreateWorkItemInput` (service) are distinct by design — the client payload takes a resolved `areaPath`; the service input takes `board`/`areaPath` and resolves. `clone`'s `overrides` is `Partial<CreateWorkItemInput>`; the MCP tool maps snake_case (`assigned_to`) → camelCase (`assignedTo`) before calling. `addRelation(fromId, toId, relType)` signature is identical across interface, both clients, and all callers.
