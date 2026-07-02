# P1b — Tool Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Define every tool exactly once in a core registry (`TOOL_SPECS`), derive both the MCP and Copilot surfaces from it via two thin adapters, fix the three audit-confirmed drift bugs while migrating, collapse the duplicated ADO clients, and derive `WRITE_TOOLS` from the registry.

**Architecture:** `@sre/core` gains `src/tools/registry.ts` (the `ToolSpec` type + `TOOL_SPECS` table + `WRITE_TOOL_NAMES`) and `src/tools/specs/*.ts` (one file per tool group holding schema + projection + guard once). `@sre/mcp-server` keeps a single `registerRegistryTools` adapter that wraps results in `{content:[{type:"text",...}]}`/`isError`; `@sre/sre-agent` keeps a single `toCopilotTool` adapter that sets `skipPermission = !spec.write` and returns raw objects / `{error}`. Migration is group-by-group: after each task both surfaces serve the migrated group from the registry and the old per-surface definitions for that group are deleted, with the full test suite green.

**Tech Stack:** TypeScript strict ESM, zod v4 (all packages), `@modelcontextprotocol/sdk` ^1.12, `@github/copilot-sdk` 1.0.1, vitest 2.

## Global Constraints

- One branch `feature/p1b-tool-registry`, one squash-PR at the end. Commit after every task.
- **Before EVERY commit run: `npm run build && npm test && npm run lint && npm run format:check`.** CI has a Prettier gate; P0 and P1a both failed CI on this — do not skip `format:check`.
- `@sre/core` must NOT gain a dependency on `@github/copilot-sdk` or `@modelcontextprotocol/sdk`. Adapters that need SDK types live in the surface packages.
- Tool success projections stay **byte-identical** to today's output except the intentional deltas listed below. Existing tests that pin behavior are the guardrail — update them only where a delta below says so.
- zod v4 idioms only. `schema` in a spec is a **raw zod shape** (`z.ZodRawShape`), not `z.object(...)` — the MCP SDK registers raw shapes, the Copilot adapter wraps with `z.object()`.
- Error convention (fixed, used by every spec): expected failures (`not found`, bad input, integration disabled at runtime) `throw new ToolError("<user-facing message>")`; unexpected errors propagate. Adapters catch both. Specs never return `{error}` themselves and never format MCP content blocks.
- Run test files with `npx vitest run <path>` from the repo root; full suite is `npm test`.

## Intentional behavior deltas (the ONLY allowed changes; everything else byte-identical)

1. **Drift fix — missing guard:** Copilot `create_bug_from_incident` gains the `azureDevOps.enabled` guard MCP already has (message: `"ADO integration is disabled. Enable it to create bugs."`).
2. **Drift fix — `search_work_items` unified to one spec:** `query_text` optional on both (was required on MCP); filters = superset `query_text, work_item_type, state, area_path, assigned_to` on both (MCP gains `area_path`/`assigned_to`); ADO-enabled guard on both (Copilot gains it); projection = 10-field superset `id, title, workItemType, state, assignedTo, areaPath, iterationPath, priority, storyPoints, tags` on both (MCP gains 4 fields, Copilot gains `tags`).
3. **Drift fix — tool-set gaps:** both surfaces expose all 19 tools. MCP gains `get_work_item`; Copilot gains `create_work_item`, `clone_work_item`, `list_work_item_csvs`, `read_work_item_csv`. The two new Copilot write tools are permission-gated (no `skipPermission`).
4. `get_work_item` gains an ADO-enabled guard on both surfaces (message: `"Azure DevOps integration is disabled. Set ADO_ENABLED=true."`). Today the disabled client returns `null` → misleading "not found".
5. **MCP unexpected-error text normalized:** per-tool prefixes like `Error searching incidents: Error: boom` become `Error: boom`. Expected errors (guards, not-found, bad input) keep their exact current message text. Copilot error strings are unchanged (`String(err)` for unexpected → `"Error: boom"`).
6. **PAT client upgraded** (ADO-client collapse): `AdoPatClient.searchWorkItems` fetches the full 10-field set (lossy local `mapWorkItem` deleted, `mapAzWorkItem` reused), honors `areaPath`/`assignedTo`/`limit` filters, and passes `limit` as WIQL `$top` (was hardcoded 50).
7. **Descriptions reconciled to the richer variant** where surfaces differed: `create_bug_from_incident`, `search_work_items`, `search_knowledge`, `index_url`, `get_incident_documents` use the (longer) Copilot text on both surfaces. Exact strings are in the spec code below — no other wording changes.
8. `WRITE_TOOLS` in `sre-agent/src/engine/permissions.ts` is derived from the registry (`WRITE_TOOL_NAMES` = `create_bug_from_incident`, `create_work_item`, `clone_work_item`).

The projection/DTO requirement from the roadmap spec (§4 P1 "each tool projects domain→wire-JSON once") is satisfied by the registry itself: each wire shape now exists exactly once, in core, plus deletion of the lossy `mapWorkItem`. No separate projections module — no wire shape is shared between two tools byte-identically, so a shared helper would force behavior changes.

## File map (end state)

| File | Responsibility |
|---|---|
| `packages/core/src/tools/spec.ts` | `ToolError`, `ToolSpec`, `defineSpec` (no imports from registry — spec files depend on this, avoiding an import cycle) |
| `packages/core/src/tools/registry.ts` | `TOOL_SPECS`, `WRITE_TOOL_NAMES`; re-exports everything from `spec.ts` |
| `packages/core/src/tools/specs/incidents.ts` | `search_incidents`, `get_incident`, `summarize_incident` |
| `packages/core/src/tools/specs/changes.ts` | `search_changes`, `get_change`, `correlate_changes` |
| `packages/core/src/tools/specs/analysis.ts` | `find_sla_risks`, `find_stale_tickets`, `generate_ops_summary` |
| `packages/core/src/tools/specs/knowledge.ts` | `search_knowledge`, `index_url` |
| `packages/core/src/tools/specs/sharepoint.ts` | `get_incident_documents` |
| `packages/core/src/tools/specs/ado.ts` | `search_work_items`, `get_work_item`, `create_bug_from_incident`, `create_work_item`, `clone_work_item` |
| `packages/core/src/tools/specs/workItemCsv.ts` | `list_work_item_csvs`, `read_work_item_csv` |
| `packages/core/src/clients/ado/wiql.ts` | shared `escapeWiql` + `searchConditions` (WIQL WHERE builder) |
| `packages/core/src/clients/ado/fields.ts` | shared `workItemFieldOps` (create-op field mapping) |
| `packages/mcp-server/src/tools/registry.ts` | `toMcpHandler` + `registerRegistryTools` (the MCP adapter) |
| `packages/sre-agent/src/tools/index.ts` | `toCopilotTool` + `buildTools` (the Copilot adapter) |
| DELETED at end | `mcp-server/src/tools/{incidents,changes,analysis,ado,knowledge,sharepoint,workItemCsv}.ts`, the ~582-line Copilot tool list, local `mapWorkItem` in `core/src/clients/ado/index.ts` |

During migration (Tasks 1–7), `sre-agent/src/tools/index.ts` keeps a shrinking `legacyTools(runtime)` array of not-yet-migrated `defineTool` entries, and `mcp-server/src/server.ts` keeps calling the not-yet-deleted `register*Tools` alongside `registerRegistryTools`. Registry names and legacy names are always disjoint, so both surfaces stay complete and every test stays green after every task.

---

### Task 1: Registry core + both adapters + incidents group + parity tests

This task establishes the whole pattern. Every later group task repeats it mechanically.

**Files:**
- Create: `packages/core/src/tools/spec.ts`
- Create: `packages/core/src/tools/registry.ts`
- Create: `packages/core/src/tools/specs/incidents.ts`
- Create: `packages/core/tests/tools/registry.test.ts`
- Create: `packages/mcp-server/src/tools/registry.ts`
- Create: `packages/mcp-server/tests/tools/registry.test.ts`
- Modify: `packages/core/src/index.ts` (add one export line)
- Modify: `packages/mcp-server/src/server.ts` (swap incidents registration for registry)
- Modify: `packages/mcp-server/src/tools/index.ts` (barrel)
- Delete: `packages/mcp-server/src/tools/incidents.ts`
- Modify: `packages/sre-agent/src/tools/index.ts` (adapter + legacy split)
- Modify: `packages/sre-agent/tests/tools.test.ts` (add parity block)

**Interfaces:**
- Consumes: `AppConfig`, `McpRuntime` from core (unchanged).
- Produces (later tasks rely on these exact names/signatures):
  - `class ToolError extends Error {}`
  - `interface ToolSpec<Shape extends z.ZodRawShape = z.ZodRawShape> { name: string; description: string; schema: Shape; write?: boolean; enabledWhen?: (c: AppConfig) => string | null; run(rt: McpRuntime, args: z.infer<z.ZodObject<Shape>>): Promise<object>; }`
  - `defineSpec<S extends z.ZodRawShape>(spec: ToolSpec<S>): ToolSpec`
  - `TOOL_SPECS: ToolSpec[]`, `WRITE_TOOL_NAMES: ReadonlySet<string>` (both exported from `@sre/core`)
  - mcp-server: `registerRegistryTools(server: McpServer, runtime: McpRuntime): void`, `toMcpHandler(spec, runtime)`
  - sre-agent: `toCopilotTool(spec: ToolSpec, runtime: McpRuntime)`, `buildTools(runtime: McpRuntime)` (export name unchanged — web + CLI import it)

- [ ] **Step 1: Write the failing core registry test**

Create `packages/core/tests/tools/registry.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { TOOL_SPECS, WRITE_TOOL_NAMES, ToolError } from "../../src/tools/registry.js";

describe("TOOL_SPECS registry", () => {
  it("has unique names and complete metadata", () => {
    const names = TOOL_SPECS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    for (const s of TOOL_SPECS) {
      expect(s.name).toMatch(/^[a-z_]+$/);
      expect(s.description.length).toBeGreaterThan(10);
      expect(typeof s.schema).toBe("object");
      expect(typeof s.run).toBe("function");
    }
  });

  it("derives WRITE_TOOL_NAMES from write flags", () => {
    const expected = TOOL_SPECS.filter((s) => s.write).map((s) => s.name);
    expect([...WRITE_TOOL_NAMES].sort()).toEqual(expected.sort());
  });

  it("contains the incidents group", () => {
    const names = TOOL_SPECS.map((s) => s.name);
    expect(names).toEqual(
      expect.arrayContaining(["search_incidents", "get_incident", "summarize_incident"])
    );
  });
});

describe("incidents specs", () => {
  const spec = (n: string) => TOOL_SPECS.find((s) => s.name === n)!;

  it("search_incidents rejects unassigned_only + assigned_to with a ToolError", async () => {
    const rt: any = { serviceNowClient: { listIncidentsWithFilters: vi.fn() } };
    await expect(
      spec("search_incidents").run(rt, { unassigned_only: true, assigned_to: "x" })
    ).rejects.toThrow(ToolError);
  });

  it("search_incidents projects the 8-field incident brief", async () => {
    const inc = {
      number: "INC1",
      priority: "2",
      state: "New",
      shortDescription: "s",
      assignedTo: undefined,
      assignmentGroup: "g",
      openedAt: "o",
      updatedAt: "u",
      description: "SHOULD NOT APPEAR"
    };
    const rt: any = { serviceNowClient: { listIncidentsWithFilters: vi.fn(async () => [inc]) } };
    const out = (await spec("search_incidents").run(rt, {})) as any;
    expect(out.count).toBe(1);
    expect(out.incidents[0]).toEqual({
      number: "INC1",
      priority: "2",
      state: "New",
      shortDescription: "s",
      assignedTo: null,
      assignmentGroup: "g",
      openedAt: "o",
      updatedAt: "u"
    });
  });

  it("get_incident throws ToolError when not found", async () => {
    const rt: any = { serviceNowClient: { getIncidentByNumber: vi.fn(async () => null) } };
    await expect(spec("get_incident").run(rt, { number: "INC0" })).rejects.toThrow(
      "Incident INC0 not found"
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/core/tests/tools/registry.test.ts`
Expected: FAIL — `Cannot find module '../../src/tools/registry.js'`

- [ ] **Step 3: Implement the registry + incidents specs**

Create `packages/core/src/tools/spec.ts` (deliberately imports nothing from `registry.ts` — spec-group files depend on this module, so keeping it leaf-level avoids a registry→specs→registry import cycle whose TDZ would crash module load):

```ts
import type { z } from "zod";
import type { AppConfig } from "../config.js";
import type { McpRuntime } from "../runtime.js";

/**
 * Expected, user-facing tool failure (bad input, not found, integration
 * unavailable). Adapters surface `message` verbatim; anything else thrown
 * from `run` is formatted as an unexpected error.
 */
export class ToolError extends Error {}

export interface ToolSpec<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  /** One description serving both surfaces (MCP + Copilot). */
  description: string;
  /** Raw zod shape: MCP registers it directly, the Copilot adapter wraps it in z.object(). */
  schema: Shape;
  /** Mutates external state → permission-gated on Copilot and listed in WRITE_TOOL_NAMES. */
  write?: boolean;
  /** Returns a user-facing message when the tool is unavailable under this config, else null. */
  enabledWhen?: (c: AppConfig) => string | null;
  run(rt: McpRuntime, args: z.infer<z.ZodObject<Shape>>): Promise<object>;
}

/** Identity helper: full arg-type inference inside the spec, widened for the table. */
export const defineSpec = <S extends z.ZodRawShape>(spec: ToolSpec<S>): ToolSpec =>
  spec as ToolSpec;
```

Create `packages/core/src/tools/registry.ts`:

```ts
import { incidentSpecs } from "./specs/incidents.js";
import type { ToolSpec } from "./spec.js";

export { ToolError, defineSpec } from "./spec.js";
export type { ToolSpec } from "./spec.js";

/** Single source of truth: every tool on every surface, defined exactly once. */
export const TOOL_SPECS: ToolSpec[] = [...incidentSpecs];

/** Names of tools that mutate external state; derived, never hand-maintained. */
export const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(
  TOOL_SPECS.filter((s) => s.write).map((s) => s.name)
);
```

Create `packages/core/src/tools/specs/incidents.ts` — projections copied verbatim from `mcp-server/src/tools/incidents.ts` (identical to the Copilot copies). NOTE: spec-group files always import from `../spec.js`, never `../registry.js` (cycle):

```ts
import { z } from "zod";
import { ToolError, defineSpec } from "../spec.js";

export const incidentSpecs = [
  defineSpec({
    name: "search_incidents",
    description:
      "Search ServiceNow incidents with filters. Use to find incidents by state, priority, assignment group, or description.",
    schema: {
      state_not: z
        .string()
        .optional()
        .describe(
          "Exclude incidents with this single state name (e.g., 'Resolved' excludes only Resolved, not Closed or Canceled)"
        ),
      priority: z
        .enum(["1", "2", "3", "4"])
        .optional()
        .describe("Filter by priority: 1=Critical, 2=High, 3=Medium, 4=Low"),
      assignment_group: z.string().optional().describe("Filter by assignment group name"),
      assigned_to: z
        .string()
        .optional()
        .describe("Filter by assigned user name (mutually exclusive with unassigned_only)"),
      short_description_contains: z
        .string()
        .optional()
        .describe("Search text in short description"),
      unassigned_only: z
        .boolean()
        .optional()
        .describe("Only show incidents with no assignee (mutually exclusive with assigned_to)"),
      limit: z.number().optional().describe("Maximum results (default: 50, max: 200)")
    },
    run: async (rt, a) => {
      if (a.unassigned_only && a.assigned_to) {
        throw new ToolError(
          "unassigned_only and assigned_to are mutually exclusive — pass only one."
        );
      }
      const incidents = await rt.serviceNowClient.listIncidentsWithFilters({
        stateNot: a.state_not,
        priority: a.priority,
        assignmentGroup: a.assignment_group,
        assignedTo: a.unassigned_only ? "" : a.assigned_to,
        shortDescriptionContains: a.short_description_contains,
        limit: Math.min(a.limit ?? 50, 200)
      });
      return {
        count: incidents.length,
        incidents: incidents.map((inc) => ({
          number: inc.number,
          priority: inc.priority,
          state: inc.state,
          shortDescription: inc.shortDescription,
          assignedTo: inc.assignedTo ?? null,
          assignmentGroup: inc.assignmentGroup ?? null,
          openedAt: inc.openedAt,
          updatedAt: inc.updatedAt
        }))
      };
    }
  }),

  defineSpec({
    name: "get_incident",
    description: "Get complete details of a specific incident by number (e.g., INC0012345)",
    schema: {
      number: z.string().describe("Incident number (e.g., INC0012345)")
    },
    run: async (rt, a) => {
      const incident = await rt.serviceNowClient.getIncidentByNumber(a.number);
      if (!incident) throw new ToolError(`Incident ${a.number} not found`);
      return incident;
    }
  }),

  defineSpec({
    name: "summarize_incident",
    description:
      "Get incident details enriched with related changes and linked Azure DevOps work items. Use for incident analysis, triage, or handover.",
    schema: {
      number: z.string().describe("Incident number (e.g., INC0012345)")
    },
    run: async (rt, a) => {
      const result = await rt.incidentService.summarizeIncident(a.number);
      return {
        incident: {
          number: result.incident.number,
          priority: result.incident.priority,
          state: result.incident.state,
          shortDescription: result.incident.shortDescription,
          description: result.incident.description,
          assignedTo: result.incident.assignedTo,
          assignmentGroup: result.incident.assignmentGroup,
          businessService: result.incident.businessService,
          cmdbCi: result.incident.cmdbCi,
          openedAt: result.incident.openedAt,
          updatedAt: result.incident.updatedAt,
          slaDue: result.incident.slaDue,
          workNotes: result.incident.workNotes,
          comments: result.incident.comments
        },
        relatedChanges: result.relatedChanges.map((c) => ({
          changeNumber: c.changeNumber,
          shortDescription: c.shortDescription,
          state: c.state,
          risk: c.risk,
          correlationReason: c.correlationReason,
          confidenceScore: c.confidenceScore
        })),
        relatedWorkItems: result.relatedWorkItems.map((w) => ({
          id: w.id,
          title: w.title,
          state: w.state
        }))
      };
    }
  })
];
```

Add to `packages/core/src/index.ts` (after the existing export lines):

```ts
export * from "./tools/registry.js";
```

- [ ] **Step 4: Run the core test to verify it passes**

Run: `npx vitest run packages/core/tests/tools/registry.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing MCP adapter test**

Create `packages/mcp-server/tests/tools/registry.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { TOOL_SPECS, McpRuntime } from "@sre/core";
import { registerRegistryTools } from "../../src/tools/registry.js";

describe("registerRegistryTools parity", () => {
  it("registers every registry spec with its exact name, description, and schema", () => {
    const seen: Array<{ name: string; description: string; schema: unknown }> = [];
    const fakeServer = {
      tool: (name: string, description: string, schema: unknown) => {
        seen.push({ name, description, schema });
      }
    };
    registerRegistryTools(fakeServer as unknown as McpServer, {} as McpRuntime);
    expect(seen).toEqual(
      TOOL_SPECS.map((s) => ({ name: s.name, description: s.description, schema: s.schema }))
    );
  });
});

describe("toMcpHandler result shaping", () => {
  const runtime = (over: Record<string, unknown> = {}) =>
    ({
      config: {},
      serviceNowClient: {
        getIncidentByNumber: vi.fn(async () => null),
        listIncidentsWithFilters: vi.fn(async () => [])
      },
      ...over
    }) as unknown as McpRuntime;

  const connect = async (rt: McpRuntime) => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerRegistryTools(server, rt);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "c", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    return client;
  };

  const callJson = async (client: Client, name: string, args: Record<string, unknown>) => {
    const res = (await client.callTool({ name, arguments: args })) as {
      isError?: boolean;
      content: Array<{ type: string; text: string }>;
    };
    return { isError: res.isError ?? false, text: res.content[0].text };
  };

  it("wraps success as pretty JSON text", async () => {
    const rt = runtime({
      serviceNowClient: {
        getIncidentByNumber: vi.fn(async () => ({ number: "INC9" })),
        listIncidentsWithFilters: vi.fn(async () => [])
      }
    });
    const client = await connect(rt);
    const r = await callJson(client, "get_incident", { number: "INC9" });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text)).toEqual({ number: "INC9" });
  });

  it("surfaces ToolError messages verbatim with isError", async () => {
    const client = await connect(runtime());
    const r = await callJson(client, "get_incident", { number: "INC0" });
    expect(r.isError).toBe(true);
    expect(r.text).toBe("Incident INC0 not found");
  });

  it("formats unexpected errors as 'Error: <message>'", async () => {
    const rt = runtime({
      serviceNowClient: {
        getIncidentByNumber: vi.fn(async () => {
          throw new Error("boom");
        }),
        listIncidentsWithFilters: vi.fn(async () => [])
      }
    });
    const client = await connect(rt);
    const r = await callJson(client, "get_incident", { number: "INC1" });
    expect(r.isError).toBe(true);
    expect(r.text).toBe("Error: boom");
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run packages/mcp-server/tests/tools/registry.test.ts`
Expected: FAIL — `Cannot find module '../../src/tools/registry.js'` (note: `@sre/core` must be rebuilt first — run `npm run build` so the new registry export exists in `core/dist`)

- [ ] **Step 7: Implement the MCP adapter**

Create `packages/mcp-server/src/tools/registry.ts`:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOL_SPECS, ToolError } from "@sre/core";
import type { McpRuntime, ToolSpec } from "@sre/core";

interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

const errorResult = (text: string): McpToolResult => ({
  content: [{ type: "text", text }],
  isError: true
});

export const toMcpHandler =
  (spec: ToolSpec, runtime: McpRuntime) =>
  async (args: Record<string, unknown>): Promise<McpToolResult> => {
    try {
      const disabled = spec.enabledWhen?.(runtime.config);
      if (disabled) return errorResult(disabled);
      const result = await spec.run(runtime, args as never);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      if (err instanceof ToolError) return errorResult(err.message);
      return errorResult(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

export const registerRegistryTools = (server: McpServer, runtime: McpRuntime): void => {
  for (const spec of TOOL_SPECS) {
    server.tool(spec.name, spec.description, spec.schema, toMcpHandler(spec, runtime));
  }
};
```

Modify `packages/mcp-server/src/server.ts`: remove the `registerIncidentTools` import and call; add `import { registerRegistryTools } from "./tools/registry.js";` and call `registerRegistryTools(server, runtime);` FIRST in the tool-registration block (before the remaining `register*Tools` calls).

Modify `packages/mcp-server/src/tools/index.ts`: remove the `registerIncidentTools` line, add `export { registerRegistryTools, toMcpHandler } from "./registry.js";`.

Delete `packages/mcp-server/src/tools/incidents.ts`.

- [ ] **Step 8: Build and run the MCP tests**

Run: `npm run build && npx vitest run packages/mcp-server/tests/tools/registry.test.ts packages/mcp-server/tests/tools/tools.test.ts`
Expected: PASS (tools.test.ts doesn't touch incidents; it still uses the old changes/ado/analysis registrars)

- [ ] **Step 9: Write the failing Copilot parity test**

Append this describe block to `packages/sre-agent/tests/tools.test.ts`:

```ts
import { TOOL_SPECS } from "@sre/core";

describe("registry parity (Copilot surface)", () => {
  it("exposes every registry spec with matching description, permission, and schema keys", () => {
    const tools = buildTools(fakeRuntime());
    for (const spec of TOOL_SPECS) {
      const t: any = tools.find((tool) => tool.name === spec.name);
      expect(t, `registry tool ${spec.name} missing from buildTools`).toBeTruthy();
      expect(t.description).toBe(spec.description);
      expect(Boolean(t.skipPermission)).toBe(!spec.write);
      expect(Object.keys(t.parameters.shape).sort()).toEqual(Object.keys(spec.schema).sort());
    }
  });
});
```

(Put the `TOOL_SPECS` import at the top of the file with the other imports.)

- [ ] **Step 10: Run it to verify it fails**

Run: `npx vitest run packages/sre-agent/tests/tools.test.ts`
Expected: FAIL — `t.parameters.shape` mismatch or handler-behavior differences, because `buildTools` still hand-defines the incident tools (the parity block compares against the registry, which the old list doesn't come from). If it happens to pass structurally, proceed — the real switch is Step 11.

- [ ] **Step 11: Implement the Copilot adapter and migrate incidents**

Rewrite the top of `packages/sre-agent/src/tools/index.ts`. The final structure of the file is:

```ts
import { defineTool } from "@github/copilot-sdk";
import { z } from "zod";
import { TOOL_SPECS, ToolError } from "@sre/core";
import type { McpRuntime, ToolSpec } from "@sre/core";

/**
 * Copilot adapter over the core tool registry. Read tools skip the permission
 * gate; write tools (spec.write) surface a permission request handled by
 * makePermissionHandler. Handlers never throw: expected failures (ToolError)
 * and unexpected errors both come back as { error } so the model sees a
 * structured error instead of the turn failing.
 */
export const toCopilotTool = (spec: ToolSpec, runtime: McpRuntime) =>
  defineTool(spec.name, {
    description: spec.description,
    skipPermission: !spec.write,
    parameters: z.object(spec.schema),
    handler: async (args: unknown) => {
      try {
        const disabled = spec.enabledWhen?.(runtime.config);
        if (disabled) return { error: disabled };
        return await spec.run(runtime, args as never);
      } catch (err) {
        return { error: err instanceof ToolError ? err.message : String(err) };
      }
    }
  });

/** Tools not yet migrated to the core registry — shrinks to [] by Task 7, then this scaffold is deleted. */
const legacyTools = (runtime: McpRuntime) => [
  // ... the existing defineTool entries for every group EXCEPT incidents,
  // moved here verbatim (search_changes, get_change, correlate_changes,
  // find_sla_risks, find_stale_tickets, generate_ops_summary,
  // search_work_items, get_work_item, create_bug_from_incident,
  // search_knowledge, get_incident_documents, index_url)
];

export const buildTools = (runtime: McpRuntime) => [
  ...TOOL_SPECS.map((s) => toCopilotTool(s, runtime)),
  ...legacyTools(runtime)
];
```

Concretely: delete the `search_incidents`, `get_incident`, `summarize_incident` `defineTool` entries; wrap the remaining 12 entries in `legacyTools`; add the adapter and the new `buildTools` composition. Do not touch the bodies of the 12 remaining entries.

- [ ] **Step 12: Run the full suite**

Run: `npm run build && npm test`
Expected: PASS — 452 pre-existing tests plus the new ones. Pay attention to `packages/sre-agent/tests/tools.test.ts` ("registers exactly the 15 expected tools" must still pass — the name set is unchanged) and `packages/sre-agent/tests/exports.test.ts`.

- [ ] **Step 13: Lint, format, commit**

Run: `npm run lint && npm run format:check` (fix with `npm run lint:fix` / `npx prettier --write .` if needed)

```bash
git add -A
git commit -m "feat(p1b): core tool registry + MCP/Copilot adapters; migrate incidents group"
```

---

### Task 2: Migrate the changes group

**Files:**
- Create: `packages/core/src/tools/specs/changes.ts`
- Modify: `packages/core/src/tools/registry.ts` (add group to `TOOL_SPECS`)
- Modify: `packages/core/tests/tools/registry.test.ts` (extend names assertion + behavior tests)
- Modify: `packages/mcp-server/src/server.ts`, `packages/mcp-server/src/tools/index.ts` (drop changes registration)
- Delete: `packages/mcp-server/src/tools/changes.ts`
- Modify: `packages/mcp-server/tests/tools/tools.test.ts` (use `registerRegistryTools` for changes)
- Modify: `packages/sre-agent/src/tools/index.ts` (remove 3 entries from `legacyTools`)

**Interfaces:**
- Consumes: `defineSpec`, `ToolError` from Task 1.
- Produces: `changeSpecs: ToolSpec[]` exported from `specs/changes.ts`; `TOOL_SPECS = [...incidentSpecs, ...changeSpecs]`.

- [ ] **Step 1: Write failing registry tests for the group**

Add to `packages/core/tests/tools/registry.test.ts`:

```ts
describe("changes specs", () => {
  const spec = (n: string) => TOOL_SPECS.find((s) => s.name === n)!;

  it("registers the changes group", () => {
    const names = TOOL_SPECS.map((s) => s.name);
    expect(names).toEqual(
      expect.arrayContaining(["search_changes", "get_change", "correlate_changes"])
    );
  });

  it("search_changes filters risk client-side", async () => {
    const rows = [
      { number: "C1", state: "New", shortDescription: "a", risk: "High" },
      { number: "C2", state: "New", shortDescription: "b", risk: "Low" }
    ];
    const rt: any = { serviceNowClient: { listChangesWithFilters: vi.fn(async () => rows) } };
    const out = (await spec("search_changes").run(rt, { risk: "High" })) as any;
    expect(out.count).toBe(1);
    expect(out.changes[0].number).toBe("C1");
  });

  it("get_change throws ToolError when not found", async () => {
    const rt: any = { serviceNowClient: { getChangeByNumber: vi.fn(async () => null) } };
    await expect(spec("get_change").run(rt, { number: "CHG0" })).rejects.toThrow(
      "Change CHG0 not found"
    );
  });

  it("correlate_changes passes undefined window when neither bound is set", async () => {
    const findRelatedChanges = vi.fn(async () => []);
    const rt: any = {
      config: { thresholds: { relatedChangeWindow: { beforeHours: 24, afterHours: 4 } } },
      incidentService: { findRelatedChanges }
    };
    await spec("correlate_changes").run(rt, { incident_number: "INC1" });
    expect(findRelatedChanges).toHaveBeenCalledWith("INC1", undefined);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/core/tests/tools/registry.test.ts`
Expected: FAIL — changes names missing from `TOOL_SPECS`

- [ ] **Step 3: Implement the specs**

Create `packages/core/src/tools/specs/changes.ts` (bodies copied verbatim from `mcp-server/src/tools/changes.ts`):

```ts
import { z } from "zod";
import { ToolError, defineSpec } from "../spec.js";

export const changeSpecs = [
  defineSpec({
    name: "search_changes",
    description: "Search ServiceNow change records with filters",
    schema: {
      state_not: z
        .string()
        .optional()
        .describe(
          "Exclude changes with this state. Numeric change_request state code (e.g. '3'=Implement, '4'=Review), not a state name"
        ),
      assignment_group: z.string().optional().describe("Filter by assignment group"),
      configuration_item: z.string().optional().describe("Filter by configuration item"),
      started_after: z.string().optional().describe("Changes started after this date (ISO 8601)"),
      started_before: z.string().optional().describe("Changes started before this date (ISO 8601)"),
      risk: z.enum(["High", "Medium", "Low"]).optional().describe("Filter by risk level"),
      limit: z.number().optional().describe("Maximum results (default: 50)")
    },
    run: async (rt, a) => {
      const changes = await rt.serviceNowClient.listChangesWithFilters({
        stateNot: a.state_not,
        assignmentGroup: a.assignment_group,
        configurationItem: a.configuration_item,
        startedAfter: a.started_after,
        startedBefore: a.started_before,
        limit: a.limit ?? 50
      });

      // Risk is a display value not exposed to the encoded query, so filter it client-side.
      let filteredChanges = changes;
      if (a.risk) {
        filteredChanges = changes.filter((c) => c.risk?.toLowerCase() === a.risk?.toLowerCase());
      }

      return {
        count: filteredChanges.length,
        changes: filteredChanges.map((c) => ({
          number: c.number,
          state: c.state,
          shortDescription: c.shortDescription,
          risk: c.risk,
          assignmentGroup: c.assignmentGroup,
          plannedStartDate: c.plannedStartDate,
          plannedEndDate: c.plannedEndDate,
          actualStartDate: c.actualStartDate
        }))
      };
    }
  }),

  defineSpec({
    name: "get_change",
    description: "Get complete details of a specific change record by number (e.g., CHG0005432)",
    schema: {
      number: z.string().describe("Change number (e.g., CHG0005432)")
    },
    run: async (rt, a) => {
      const change = await rt.serviceNowClient.getChangeByNumber(a.number);
      if (!change) throw new ToolError(`Change ${a.number} not found`);
      return change;
    }
  }),

  defineSpec({
    name: "correlate_changes",
    description:
      "Find changes that may be related to an incident by configuration item, business service, assignment group, or time window",
    schema: {
      incident_number: z.string().describe("Incident to find related changes for"),
      window_hours_before: z
        .number()
        .optional()
        .describe("Hours before incident to search (default: 24)"),
      window_hours_after: z
        .number()
        .optional()
        .describe("Hours after incident to search (default: 4)")
    },
    run: async (rt, a) => {
      // Build a per-call window only if the caller overrode either bound; otherwise
      // pass undefined so the service uses the configured CORRELATION_HOURS_* defaults.
      const defaults = rt.config.thresholds.relatedChangeWindow;
      const window =
        a.window_hours_before !== undefined || a.window_hours_after !== undefined
          ? {
              beforeHours: a.window_hours_before ?? defaults.beforeHours,
              afterHours: a.window_hours_after ?? defaults.afterHours
            }
          : undefined;
      const relatedChanges = await rt.incidentService.findRelatedChanges(a.incident_number, window);

      return {
        incidentNumber: a.incident_number,
        count: relatedChanges.length,
        changes: relatedChanges.map((c) => ({
          changeNumber: c.changeNumber,
          shortDescription: c.shortDescription,
          state: c.state,
          risk: c.risk,
          plannedStart: c.plannedStart,
          actualStart: c.actualStart,
          correlationReason: c.correlationReason,
          confidenceScore: c.confidenceScore
        }))
      };
    }
  })
];
```

In `packages/core/src/tools/registry.ts`, add the import and extend the table:

```ts
import { changeSpecs } from "./specs/changes.js";
// ...
export const TOOL_SPECS: ToolSpec[] = [...incidentSpecs, ...changeSpecs];
```

- [ ] **Step 4: Run core tests**

Run: `npx vitest run packages/core/tests/tools/registry.test.ts`
Expected: PASS

- [ ] **Step 5: Cut both surfaces over**

- Delete `packages/mcp-server/src/tools/changes.ts`; remove its line from `packages/mcp-server/src/tools/index.ts` and its import/call from `packages/mcp-server/src/server.ts`.
- In `packages/mcp-server/tests/tools/tools.test.ts`: replace the `registerChangeTools` import with `import { registerRegistryTools } from "../../src/tools/registry.js";` and in `connect()` replace `registerChangeTools(server, runtime);` with `registerRegistryTools(server, runtime);` (keep `registerAdoTools` and `registerAnalysisTools` calls — those groups are not migrated yet). The `makeRuntime` fake must also gain `getIncidentByNumber`/`getChangeByNumber`/`summarizeIncident`/`listIncidentsWithFilters` vi.fn stubs on `serviceNowClient`/`incidentService` ONLY IF a failure shows the registry registration path touching them — it does not (registration is lazy; handlers run only when called). Leave the fake as-is unless a test fails.
- In `packages/sre-agent/src/tools/index.ts`: delete the `search_changes`, `get_change`, `correlate_changes` entries from `legacyTools`.

- [ ] **Step 6: Full suite, lint, commit**

Run: `npm run build && npm test && npm run lint && npm run format:check`
Expected: all green (the sre-agent 15-name test is unchanged — same name set).

```bash
git add -A
git commit -m "feat(p1b): migrate changes group to the tool registry"
```

---

### Task 3: Migrate the analysis group

**Files:**
- Create: `packages/core/src/tools/specs/analysis.ts`
- Modify: `packages/core/src/tools/registry.ts`
- Modify: `packages/core/tests/tools/registry.test.ts`
- Modify: `packages/mcp-server/src/server.ts`, `packages/mcp-server/src/tools/index.ts`
- Delete: `packages/mcp-server/src/tools/analysis.ts`
- Modify: `packages/mcp-server/tests/tools/tools.test.ts` (drop `registerAnalysisTools`)
- Modify: `packages/sre-agent/src/tools/index.ts` (remove 3 entries)

**Interfaces:**
- Produces: `analysisSpecs: ToolSpec[]`; `TOOL_SPECS = [...incidentSpecs, ...changeSpecs, ...analysisSpecs]`.

- [ ] **Step 1: Write failing registry tests**

Add to `packages/core/tests/tools/registry.test.ts`:

```ts
describe("analysis specs", () => {
  const spec = (n: string) => TOOL_SPECS.find((s) => s.name === n)!;

  it("registers the analysis group", () => {
    const names = TOOL_SPECS.map((s) => s.name);
    expect(names).toEqual(
      expect.arrayContaining(["find_sla_risks", "find_stale_tickets", "generate_ops_summary"])
    );
  });

  it("find_sla_risks applies the minimum risk-level filter", async () => {
    const risks = [
      { incidentNumber: "I1", riskLevel: "Critical" },
      { incidentNumber: "I2", riskLevel: "Medium" }
    ];
    const rt: any = { incidentService: { listSlaRisks: vi.fn(async () => risks) } };
    const out = (await spec("find_sla_risks").run(rt, { risk_level: "High" })) as any;
    expect(out.count).toBe(1);
    expect(out.risks[0].incidentNumber).toBe("I1");
  });

  it("generate_ops_summary rejects an invalid date with ToolError", async () => {
    const rt: any = { reportService: { generateDailyOpsReport: vi.fn() } };
    await expect(spec("generate_ops_summary").run(rt, { date: "not-a-date" })).rejects.toThrow(
      ToolError
    );
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/core/tests/tools/registry.test.ts`
Expected: FAIL — analysis names missing

- [ ] **Step 3: Implement**

Create `packages/core/src/tools/specs/analysis.ts` (bodies verbatim from `mcp-server/src/tools/analysis.ts`):

```ts
import { z } from "zod";
import { ToolError, defineSpec } from "../spec.js";

export const analysisSpecs = [
  defineSpec({
    name: "find_sla_risks",
    description:
      "Find open incidents at risk of SLA breach. Risk levels: Critical (<10% time), High (<25%), Medium (<50%)",
    schema: {
      assignment_group: z.string().optional().describe("Filter to specific team"),
      priorities: z
        .array(z.enum(["1", "2", "3", "4"]))
        .optional()
        .describe("Filter to specific priorities (e.g., ['1', '2'])"),
      risk_level: z
        .enum(["Critical", "High", "Medium"])
        .optional()
        .describe("Minimum risk level to include")
    },
    run: async (rt, a) => {
      const risks = await rt.incidentService.listSlaRisks({
        onlyOpen: true,
        assignmentGroup: a.assignment_group,
        priorities: a.priorities
      });

      let filteredRisks = risks;
      if (a.risk_level) {
        const riskOrder = { Critical: 0, High: 1, Medium: 2 };
        const minLevel = riskOrder[a.risk_level];
        filteredRisks = risks.filter((r) => riskOrder[r.riskLevel] <= minLevel);
      }

      return {
        count: filteredRisks.length,
        risks: filteredRisks.map((r) => ({
          incidentNumber: r.incidentNumber,
          priority: r.priority,
          assignmentGroup: r.assignmentGroup,
          slaDue: r.slaDue,
          remainingMinutes: r.remainingMinutes,
          riskLevel: r.riskLevel,
          suggestedAction: r.suggestedAction
        }))
      };
    }
  }),

  defineSpec({
    name: "find_stale_tickets",
    description:
      "Find tickets not updated within expected thresholds. Thresholds: P1=30min, P2=2h, P3=24h, P4=72h",
    schema: {
      assignment_group: z.string().optional().describe("Filter to specific team"),
      priorities: z
        .array(z.enum(["1", "2", "3", "4"]))
        .optional()
        .describe("Filter to specific priorities")
    },
    run: async (rt, a) => {
      const staleTickets = await rt.incidentService.listStaleIncidents({
        onlyOpen: true,
        assignmentGroup: a.assignment_group,
        priorities: a.priorities
      });

      return {
        count: staleTickets.length,
        tickets: staleTickets.map((t) => ({
          incidentNumber: t.incidentNumber,
          priority: t.priority,
          assignmentGroup: t.assignmentGroup,
          lastUpdated: t.lastUpdated,
          staleByMinutes: t.staleByMinutes,
          thresholdMinutes: t.thresholdMinutes
        }))
      };
    }
  }),

  defineSpec({
    name: "generate_ops_summary",
    description:
      "Generate a daily operations summary with key metrics, risks, and recommended actions",
    schema: {
      date: z.string().optional().describe("Date for summary (ISO 8601, default: today)"),
      assignment_group: z.string().optional().describe("Focus on specific team")
    },
    run: async (rt, a) => {
      let now: Date | undefined;
      if (a.date) {
        const parsed = new Date(a.date);
        if (Number.isNaN(parsed.getTime())) {
          throw new ToolError(`Invalid date: ${a.date}. Use ISO 8601, e.g. 2026-06-11.`);
        }
        now = parsed;
      }
      const report = await rt.reportService.generateDailyOpsReport({
        now,
        assignmentGroup: a.assignment_group
      });

      return {
        generatedAt: report.generatedAt,
        generatedForDate: report.generatedForDate,
        executiveSummary: report.executiveSummary,
        openIncidentsByPriority: report.openIncidentsByPriority,
        slaRisksCount: report.slaRisks.length,
        slaRisks: report.slaRisks.slice(0, 10).map((r) => ({
          incidentNumber: r.incidentNumber,
          priority: r.priority,
          remainingMinutes: r.remainingMinutes,
          riskLevel: r.riskLevel
        })),
        staleIncidentsCount: report.staleIncidents.length,
        staleIncidents: report.staleIncidents.slice(0, 10).map((t) => ({
          incidentNumber: t.incidentNumber,
          priority: t.priority,
          staleByMinutes: t.staleByMinutes
        })),
        majorIncidentsCount: report.majorIncidents.length,
        failedOrHighRiskChangesCount: report.failedOrHighRiskChanges.length,
        upcomingChangesCount: report.upcomingChanges.length,
        recommendedActions: report.recommendedActions
      };
    }
  })
];
```

Registry: `import { analysisSpecs } from "./specs/analysis.js";` and `TOOL_SPECS = [...incidentSpecs, ...changeSpecs, ...analysisSpecs];`

Surfaces:
- Delete `packages/mcp-server/src/tools/analysis.ts`; update barrel + `server.ts`.
- `packages/mcp-server/tests/tools/tools.test.ts`: remove the `registerAnalysisTools` import and call (registry covers it now).
- `packages/sre-agent/src/tools/index.ts`: remove `find_sla_risks`, `find_stale_tickets`, `generate_ops_summary` from `legacyTools`.

- [ ] **Step 4: Full suite, lint, commit**

Run: `npm run build && npm test && npm run lint && npm run format:check`
Expected: PASS

```bash
git add -A
git commit -m "feat(p1b): migrate analysis group to the tool registry"
```

---

### Task 4: Migrate the knowledge + SharePoint groups

**Files:**
- Create: `packages/core/src/tools/specs/knowledge.ts`, `packages/core/src/tools/specs/sharepoint.ts`
- Modify: `packages/core/src/tools/registry.ts`, `packages/core/tests/tools/registry.test.ts`
- Modify: `packages/mcp-server/src/server.ts`, `packages/mcp-server/src/tools/index.ts`
- Delete: `packages/mcp-server/src/tools/knowledge.ts`, `packages/mcp-server/src/tools/sharepoint.ts`, `packages/mcp-server/src/tools/sharepoint.test.ts`
- Create: `packages/mcp-server/tests/tools/sharepoint.test.ts` (relocated + rewritten against registry)
- Modify: `packages/mcp-server/tests/knowledge-tools.test.ts` (use `registerRegistryTools`)
- Modify: `packages/sre-agent/src/tools/index.ts` (remove 3 entries)
- Modify: `packages/sre-agent/src/tools/index.test.ts` (fakes gain `config.sharePoint`)
- Modify: `packages/sre-agent/tests/knowledge-tools.test.ts` (only if a failure shows the fakes need `config`)

**Interfaces:**
- Produces: `knowledgeSpecs: ToolSpec[]`, `sharePointSpecs: ToolSpec[]`.

- [ ] **Step 1: Write failing registry tests**

Add to `packages/core/tests/tools/registry.test.ts`:

```ts
describe("knowledge + sharepoint specs", () => {
  const spec = (n: string) => TOOL_SPECS.find((s) => s.name === n)!;

  it("registers the groups", () => {
    const names = TOOL_SPECS.map((s) => s.name);
    expect(names).toEqual(
      expect.arrayContaining(["search_knowledge", "index_url", "get_incident_documents"])
    );
  });

  it("index_url clamps depth to 2 and pages to 25", async () => {
    const crawl = vi.fn(async () => ({ pagesCrawled: 1, chunksAdded: 2, pagesSkipped: 0 }));
    const rt: any = { knowledge: { crawl } };
    const out = await spec("index_url").run(rt, { url: "https://w", depth: 9, max_pages: 999 });
    expect(crawl).toHaveBeenCalledWith(
      { seeds: ["https://w"], maxDepth: 2, maxPages: 25 },
      expect.any(Function)
    );
    expect(out).toEqual({ pages_crawled: 1, chunks_added: 2, skipped: 0 });
  });

  it("get_incident_documents is disabled by config and guarded at runtime", async () => {
    const sp = spec("get_incident_documents");
    expect(sp.enabledWhen!({ sharePoint: { enabled: false } } as any)).toMatch(/disabled/);
    expect(sp.enabledWhen!({ sharePoint: { enabled: true } } as any)).toBeNull();
    await expect(sp.run({ sharePoint: undefined } as any, { incident: "INC1" })).rejects.toThrow(
      "SharePoint integration is disabled (set SHAREPOINT_ENABLED=true)."
    );
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/core/tests/tools/registry.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement**

Create `packages/core/src/tools/specs/knowledge.ts` (Copilot descriptions — the richer variant, delta #7):

```ts
import { z } from "zod";
import { defineSpec } from "../spec.js";

export const knowledgeSpecs = [
  defineSpec({
    name: "search_knowledge",
    description:
      "Search the internal documentation knowledge index (runbooks, wikis, KB) by meaning. Use to find a procedure, fix, or reference relevant to an incident. Returns ranked snippets with source URLs to cite.",
    schema: {
      query: z.string().describe("Natural-language search query"),
      k: z.number().optional().describe("Number of results (default 6, max 20)"),
      domain: z.string().optional().describe("Restrict to a single host, e.g. wiki.acme.io")
    },
    run: async (rt, a) => rt.knowledge.search(a.query, a.k, a.domain)
  }),

  defineSpec({
    name: "index_url",
    description:
      "Crawl and index a small set of internal pages starting from a URL into the knowledge index, then they become searchable via search_knowledge. Bounded (shallow, few pages) for use mid-conversation; use the `sre-agent crawl` CLI for full site ingest.",
    schema: {
      url: z.string().describe("Seed URL to crawl from (must be within an allowed domain)"),
      depth: z.number().optional().describe("Link-follow depth, clamped to 2"),
      max_pages: z.number().optional().describe("Max pages, clamped to 25")
    },
    run: async (rt, a) => {
      const res = await rt.knowledge.crawl(
        {
          seeds: [a.url],
          maxDepth: Math.min(a.depth ?? 1, 2),
          maxPages: Math.min(a.max_pages ?? 10, 25)
        },
        () => {}
      );
      return {
        pages_crawled: res.pagesCrawled,
        chunks_added: res.chunksAdded,
        skipped: res.pagesSkipped
      };
    }
  })
];
```

Create `packages/core/src/tools/specs/sharepoint.ts`:

```ts
import { z } from "zod";
import { ToolError, defineSpec } from "../spec.js";

const DISABLED_MSG = "SharePoint integration is disabled (set SHAREPOINT_ENABLED=true).";

export const sharePointSpecs = [
  defineSpec({
    name: "get_incident_documents",
    description:
      "Fetch an incident's supporting documents from SharePoint by incident number (e.g. INC123456). " +
      "Recursively reads the incident folder's Docs subtree (docx/xlsx/pptx/pdf) and returns extracted " +
      "text to read and cite. Use when the user references an incident and asks about its docs, runbook, " +
      "postmortem, or details that live in SharePoint rather than ServiceNow.",
    schema: {
      incident: z.string().describe("Incident number, e.g. INC123456")
    },
    enabledWhen: (c) => (c.sharePoint.enabled ? null : DISABLED_MSG),
    run: async (rt, a) => {
      // Defense in depth: enabledWhen gates on config, this guards a runtime without the service.
      if (!rt.sharePoint) throw new ToolError(DISABLED_MSG);
      return rt.sharePoint.getIncidentDocuments(a.incident);
    }
  })
];
```

Registry: add both imports; `TOOL_SPECS = [...incidentSpecs, ...changeSpecs, ...analysisSpecs, ...knowledgeSpecs, ...sharePointSpecs];`

Surfaces:
- Delete `packages/mcp-server/src/tools/knowledge.ts` and `packages/mcp-server/src/tools/sharepoint.ts`; update barrel + `server.ts` (remove `registerKnowledgeTools`/`registerSharePointTools`).
- Move/rewrite `packages/mcp-server/src/tools/sharepoint.test.ts` → `packages/mcp-server/tests/tools/sharepoint.test.ts`: same two behaviors, but `registerSharePointTools(server, runtime)` becomes `registerRegistryTools(server, runtime)` and the fake runtimes gain `config: { sharePoint: { enabled: true } }` (first test) / `config: { sharePoint: { enabled: false } }` (disabled test). The disabled assertion checks the text equals `"SharePoint integration is disabled (set SHAREPOINT_ENABLED=true)."`.
- `packages/mcp-server/tests/knowledge-tools.test.ts`: swap `registerKnowledgeTools` → `registerRegistryTools` (import from `../src/tools/registry.js`); fakes need a `config: {}` property only if the run shows otherwise (knowledge specs have no `enabledWhen`, and the adapter only calls `spec.enabledWhen?.(...)`, so `config` may stay absent).
- `packages/sre-agent/src/tools/index.ts`: remove `search_knowledge`, `get_incident_documents`, `index_url` from `legacyTools` (leaving only the 6 ADO-related entries).
- `packages/sre-agent/src/tools/index.test.ts`: the fake runtimes gain config — first test `config: { sharePoint: { enabled: true } }`, disabled test becomes `toolByName({ config: { sharePoint: { enabled: false } } }, ...)`, error-wrap test `config: { sharePoint: { enabled: true } }`. Expected outputs unchanged.

- [ ] **Step 4: Full suite, lint, commit**

Run: `npm run build && npm test && npm run lint && npm run format:check`
Expected: PASS

```bash
git add -A
git commit -m "feat(p1b): migrate knowledge and sharepoint groups to the tool registry"
```

---

### Task 5: Collapse the two ADO clients (shared WIQL + field ops, delete lossy mapWorkItem)

Pure core task; no tool-surface changes. Prerequisite for the unified `search_work_items` (Task 6): the PAT client must return the full 10-field projection and honor all filters.

**Files:**
- Create: `packages/core/src/clients/ado/wiql.ts`
- Create: `packages/core/src/clients/ado/fields.ts`
- Create: `packages/core/tests/clients/adoShared.test.ts`
- Modify: `packages/core/src/clients/ado/index.ts` (delete `AdoWorkItemRow`, `escapeWiql`, `mapWorkItem`; rewrite `searchWorkItems` + `buildCreateOps` on the shared helpers)
- Modify: `packages/core/src/clients/ado/azBoards.ts` (delete local `esc`; use shared helpers)
- Modify: `packages/core/tests/clients/ado.test.ts` (expectations: full field fetch, `$top`, new filters; op order)
- Modify: `packages/core/tests/clients/azBoards.test.ts` (only if WIQL string ordering changed — it must not; conditions keep today's order)

**Interfaces:**
- Consumes: `WorkItemSearchFilters`, `CreateWorkItemPayload` from `clients/ado/types.ts`; `mapAzWorkItem`, `AzWorkItemRaw` from `clients/ado/map.ts`.
- Produces:
  - `escapeWiql(s: string): string`
  - `searchConditions(f: WorkItemSearchFilters): string[]` — WHERE clauses in the order: text, workItemType, state, areaPath, assignedTo
  - `interface FieldOp { referenceName: string; value: string | number }`
  - `workItemFieldOps(p: CreateWorkItemPayload): FieldOp[]` — description/tags/priority/storyPoints/extra fields (title, area, iteration, assignee stay client-specific)

- [ ] **Step 1: Write failing tests for the shared helpers**

Create `packages/core/tests/clients/adoShared.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { escapeWiql, searchConditions } from "../../src/clients/ado/wiql.js";
import { workItemFieldOps } from "../../src/clients/ado/fields.js";

describe("searchConditions", () => {
  it("escapes quotes and builds all five filters in order", () => {
    expect(
      searchConditions({
        text: "o'hare",
        workItemType: "Bug",
        state: "Active",
        areaPath: "Proj\\Team",
        assignedTo: "me@x.com"
      })
    ).toEqual([
      "[System.Title] CONTAINS 'o''hare'",
      "[System.WorkItemType] = 'Bug'",
      "[System.State] = 'Active'",
      "[System.AreaPath] UNDER 'Proj\\Team'",
      "[System.AssignedTo] = 'me@x.com'"
    ]);
  });

  it("maps @Me to the WIQL macro unquoted", () => {
    expect(searchConditions({ assignedTo: "@Me" })).toEqual(["[System.AssignedTo] = @Me"]);
  });

  it("returns [] for no filters", () => {
    expect(searchConditions({})).toEqual([]);
  });

  it("escapeWiql doubles single quotes", () => {
    expect(escapeWiql("a'b''c")).toBe("a''b''''c");
  });
});

describe("workItemFieldOps", () => {
  it("routes Bug descriptions to ReproSteps as HTML", () => {
    expect(workItemFieldOps({ type: "Bug", title: "t", description: "l1\nl2" })).toEqual([
      { referenceName: "Microsoft.VSTS.TCM.ReproSteps", value: "l1<br>l2" }
    ]);
  });

  it("maps tags, valid priority, story points, and extra fields", () => {
    expect(
      workItemFieldOps({
        type: "Task",
        title: "t",
        tags: ["a", "b"],
        priority: "2",
        storyPoints: 5,
        fields: { "Custom.Field": "v" }
      })
    ).toEqual([
      { referenceName: "System.Tags", value: "a; b" },
      { referenceName: "Microsoft.VSTS.Common.Priority", value: 2 },
      { referenceName: "Microsoft.VSTS.Scheduling.StoryPoints", value: 5 },
      { referenceName: "Custom.Field", value: "v" }
    ]);
  });

  it("drops an out-of-range priority", () => {
    expect(workItemFieldOps({ type: "Task", title: "t", priority: "9" })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/core/tests/clients/adoShared.test.ts`
Expected: FAIL — modules don't exist

- [ ] **Step 3: Implement the shared modules**

Create `packages/core/src/clients/ado/wiql.ts`:

```ts
import type { WorkItemSearchFilters } from "./types.js";

export const escapeWiql = (s: string): string => s.replace(/'/g, "''");

/** WHERE conditions for a work-item search, shared by the PAT (REST) and az-CLI clients. */
export const searchConditions = (f: WorkItemSearchFilters): string[] => {
  const where: string[] = [];
  if (f.text) where.push(`[System.Title] CONTAINS '${escapeWiql(f.text)}'`);
  if (f.workItemType) where.push(`[System.WorkItemType] = '${escapeWiql(f.workItemType)}'`);
  if (f.state) where.push(`[System.State] = '${escapeWiql(f.state)}'`);
  if (f.areaPath) where.push(`[System.AreaPath] UNDER '${escapeWiql(f.areaPath)}'`);
  if (f.assignedTo === "@Me") where.push("[System.AssignedTo] = @Me");
  else if (f.assignedTo) where.push(`[System.AssignedTo] = '${escapeWiql(f.assignedTo)}'`);
  return where;
};
```

Create `packages/core/src/clients/ado/fields.ts`:

```ts
import type { CreateWorkItemPayload } from "./types.js";

export interface FieldOp {
  referenceName: string;
  value: string | number;
}

/**
 * Field assignments shared by the REST json-patch body and the az CLI
 * `--fields` flag. Title/area/iteration/assignee are excluded: each client
 * sets those through its own mechanism (patch ops vs dedicated flags).
 */
export const workItemFieldOps = (p: CreateWorkItemPayload): FieldOp[] => {
  const ops: FieldOp[] = [];
  if (p.description != null) {
    const html = p.description.replace(/\n/g, "<br>");
    ops.push({
      referenceName:
        p.type === "Bug" ? "Microsoft.VSTS.TCM.ReproSteps" : "System.Description",
      value: html
    });
  }
  if (p.tags?.length) ops.push({ referenceName: "System.Tags", value: p.tags.join("; ") });
  const prio = p.priority ? Number(p.priority) : NaN;
  if (Number.isInteger(prio) && prio >= 1 && prio <= 4)
    ops.push({ referenceName: "Microsoft.VSTS.Common.Priority", value: prio });
  if (typeof p.storyPoints === "number")
    ops.push({ referenceName: "Microsoft.VSTS.Scheduling.StoryPoints", value: p.storyPoints });
  for (const [k, v] of Object.entries(p.fields ?? {}))
    ops.push({ referenceName: k, value: v });
  return ops;
};
```

- [ ] **Step 4: Run shared tests**

Run: `npx vitest run packages/core/tests/clients/adoShared.test.ts`
Expected: PASS

- [ ] **Step 5: Rewire `AdoPatClient` (delete the lossy path)**

In `packages/core/src/clients/ado/index.ts`:
- Delete the `AdoWorkItemRow` interface, the local `escapeWiql`, and the local `mapWorkItem` (lines 21–44 today).
- Add `import { searchConditions } from "./wiql.js";` and `import { workItemFieldOps } from "./fields.js";`
- Replace `searchWorkItems` with:

```ts
  private static readonly SEARCH_FIELDS = [
    "System.Title",
    "System.State",
    "System.WorkItemType",
    "System.AssignedTo",
    "System.AreaPath",
    "System.IterationPath",
    "System.Tags",
    "System.Parent",
    "Microsoft.VSTS.Common.Priority",
    "Microsoft.VSTS.Scheduling.StoryPoints"
  ].join(",");

  async searchWorkItems(f: WorkItemSearchFilters): Promise<WorkItem[]> {
    if (!this.cfg.enabled) return [];
    this.assertConfigured();

    const conditions = searchConditions(f);
    const where = conditions.length ? ` WHERE ${conditions.join(" AND ")}` : "";
    const query = `SELECT [System.Id] FROM WorkItems${where} ORDER BY [System.ChangedDate] DESC`;
    const limit = Math.min(f.limit ?? 50, 200);

    const wiql = await this.requestJson<{ workItems?: Array<{ id: number }> }>(
      this.apiUrl(`wit/wiql?api-version=7.1&$top=${limit}`),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: this.authHeader
        },
        body: JSON.stringify({ query })
      }
    );
    const ids = (wiql.workItems ?? []).map((w) => w.id);
    if (!ids.length) return [];

    const details = await this.requestJson<{ value?: AzWorkItemRaw[] }>(
      this.apiUrl(
        `wit/workitems?ids=${ids.join(",")}&fields=${AdoPatClient.SEARCH_FIELDS}&api-version=7.1`
      ),
      { headers: { Accept: "application/json", Authorization: this.authHeader } }
    );
    return (details.value ?? []).map(mapAzWorkItem);
  }
```

- Replace `buildCreateOps` with:

```ts
  private buildCreateOps(
    p: CreateWorkItemPayload
  ): Array<{ op: "add"; path: string; value: string | number }> {
    const ops: Array<{ op: "add"; path: string; value: string | number }> = [
      { op: "add", path: "/fields/System.Title", value: p.title }
    ];
    const areaPath = p.areaPath ?? this.cfg.defaultAreaPath;
    const iterationPath = p.iterationPath ?? this.cfg.defaultIterationPath;
    if (areaPath) ops.push({ op: "add", path: "/fields/System.AreaPath", value: areaPath });
    if (iterationPath)
      ops.push({ op: "add", path: "/fields/System.IterationPath", value: iterationPath });
    if (p.assignedTo)
      ops.push({ op: "add", path: "/fields/System.AssignedTo", value: p.assignedTo });
    for (const f of workItemFieldOps(p))
      ops.push({ op: "add", path: `/fields/${f.referenceName}`, value: f.value });
    return ops;
  }
```

(The op ORDER changes — description/tags/priority now come after area/iteration/assignee. JSON-patch `add` ops on distinct fields are order-independent; update `packages/core/tests/clients/ado.test.ts` expectations accordingly, e.g. compare as sets or update the expected array order.)

- [ ] **Step 6: Rewire `AzBoardsClient`**

In `packages/core/src/clients/ado/azBoards.ts`:
- Delete the local `const esc = ...`; add `import { searchConditions } from "./wiql.js";` and `import { workItemFieldOps } from "./fields.js";`
- In `searchWorkItems`, replace the hand-built `where` array with:

```ts
    const where = ["[System.TeamProject] = @project", ...searchConditions(f)];
```

- In `createWorkItem`, replace the hand-built `fields` array with:

```ts
    const fields = workItemFieldOps(p).map((op) => `${op.referenceName}=${op.value}`);
```

(Everything else — flags for title/area/iteration/assignee, SELECT list — stays as-is. The produced WIQL and `--fields` strings are byte-identical to today.)

- [ ] **Step 7: Full suite, lint, commit**

Run: `npm run build && npm test && npm run lint && npm run format:check`
Expected: PASS. `packages/core/tests/clients/ado.test.ts` will need updated expectations for: the wiql URL now containing `$top=<limit>`, the details URL containing the 10-field list, results including `workItemType`/`iterationPath`/`priority`/`storyPoints`/`tags` split via `mapAzWorkItem` (`/;\s*/` split — note the old local mapper split on `";"` and trimmed; verify the test fixtures). `azBoards.test.ts` must pass UNCHANGED — if it fails, the shared helpers diverged from the old az behavior; fix the helpers, not the test.

```bash
git add -A
git commit -m "refactor(p1b): collapse ADO clients onto shared WIQL/field helpers; delete lossy mapWorkItem"
```

---

### Task 6: Migrate the ADO tool group — all three drift fixes land here

**Files:**
- Create: `packages/core/src/tools/specs/ado.ts`
- Modify: `packages/core/src/tools/registry.ts`, `packages/core/tests/tools/registry.test.ts`
- Modify: `packages/mcp-server/src/server.ts`, `packages/mcp-server/src/tools/index.ts`
- Delete: `packages/mcp-server/src/tools/ado.ts`
- Modify: `packages/mcp-server/tests/tools/tools.test.ts`, `packages/mcp-server/tests/tools/work-items.test.ts` (drop `registerAdoTools`; unified search expectations)
- Modify: `packages/sre-agent/src/tools/index.ts` (remove the last 3 ADO entries from `legacyTools`)
- Modify: `packages/sre-agent/tests/tools.test.ts` (names list grows to 17; `fakeRuntime` config gains `azureDevOps.enabled: true`; drift regression tests)

**Interfaces:**
- Consumes: `runtime.azureDevOpsClient` (`searchWorkItems`, `getWorkItem`, `createBug`), `runtime.workItemService` (`create`, `clone`, `isBoardKnown`), `runtime.incidentService.summarizeIncident`, `runtime.config.azureDevOps.*`, `runtime.config.features.createAdoBug`.
- Produces: `adoSpecs: ToolSpec[]` with `create_bug_from_incident`, `create_work_item`, `clone_work_item` having `write: true`.

- [ ] **Step 1: Write failing registry tests (including the drift regressions)**

Add to `packages/core/tests/tools/registry.test.ts`:

```ts
describe("ado specs (drift fixes)", () => {
  const spec = (n: string) => TOOL_SPECS.find((s) => s.name === n)!;
  const cfg = (enabled: boolean, createAdoBug = true): any => ({
    azureDevOps: { enabled },
    features: { createAdoBug }
  });

  it("registers all five ADO tools with correct write flags", () => {
    for (const n of ["search_work_items", "get_work_item"]) expect(spec(n).write).toBeFalsy();
    for (const n of ["create_bug_from_incident", "create_work_item", "clone_work_item"])
      expect(spec(n).write).toBe(true);
  });

  // Drift fix 1: the guard exists ONCE and covers both surfaces via enabledWhen.
  it("create_bug_from_incident is disabled when ADO is off OR the feature flag is off", () => {
    expect(spec("create_bug_from_incident").enabledWhen!(cfg(false))).toBe(
      "ADO integration is disabled. Enable it to create bugs."
    );
    expect(spec("create_bug_from_incident").enabledWhen!(cfg(true, false))).toBe(
      "ADO bug creation is disabled by feature flag."
    );
    expect(spec("create_bug_from_incident").enabledWhen!(cfg(true, true))).toBeNull();
  });

  // Drift fix 2: one unified search spec.
  it("search_work_items has optional query_text, the five filters, an ADO guard, and the 10-field projection", async () => {
    const s = spec("search_work_items");
    expect(Object.keys(s.schema).sort()).toEqual(
      ["query_text", "work_item_type", "state", "area_path", "assigned_to"].sort()
    );
    expect(s.schema.query_text.safeParse(undefined).success).toBe(true);
    expect(s.enabledWhen!(cfg(false))).toMatch(/disabled/);

    const w = {
      id: 1,
      title: "t",
      workItemType: "Bug",
      state: "Active",
      assignedTo: "u",
      areaPath: "a",
      iterationPath: "i",
      priority: 2,
      storyPoints: 3,
      parentId: 9,
      tags: ["x"],
      url: "http://SHOULD-NOT-APPEAR"
    };
    const rt: any = { azureDevOpsClient: { searchWorkItems: vi.fn(async () => [w]) } };
    const out = (await s.run(rt, {})) as any;
    expect(out.workItems[0]).toEqual({
      id: 1,
      title: "t",
      workItemType: "Bug",
      state: "Active",
      assignedTo: "u",
      areaPath: "a",
      iterationPath: "i",
      priority: 2,
      storyPoints: 3,
      tags: ["x"]
    });
  });

  it("get_work_item throws ToolError when not found", async () => {
    const rt: any = { azureDevOpsClient: { getWorkItem: vi.fn(async () => null) } };
    await expect(spec("get_work_item").run(rt, { id: 404 })).rejects.toThrow(
      "Work item 404 not found"
    );
  });

  it("create_work_item surfaces a boardWarning for unknown boards", async () => {
    const rt: any = {
      workItemService: {
        isBoardKnown: vi.fn(() => false),
        create: vi.fn(async () => ({
          id: 100,
          title: "T",
          workItemType: "Task",
          areaPath: "Default"
        }))
      }
    };
    const out = (await spec("create_work_item").run(rt, { type: "Task", title: "T", board: "ghost" })) as any;
    expect(out.boardWarning).toContain('"ghost"');
    expect(out).toMatchObject({ success: true, id: 100 });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/core/tests/tools/registry.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `packages/core/src/tools/specs/ado.ts`**

```ts
import { z } from "zod";
import type { AppConfig } from "../../config.js";
import { ToolError, defineSpec } from "../spec.js";

const ADO_DISABLED = "Azure DevOps integration is disabled. Set ADO_ENABLED=true.";

const adoEnabled = (c: AppConfig): string | null => (c.azureDevOps.enabled ? null : ADO_DISABLED);

export const adoSpecs = [
  defineSpec({
    name: "search_work_items",
    description: "Search Azure DevOps work items by text, type, state, area path, or assignee",
    schema: {
      query_text: z
        .string()
        .optional()
        .describe("Text to search for in the title (e.g., incident number)"),
      work_item_type: z
        .enum(["Bug", "Task", "User Story", "Issue"])
        .optional()
        .describe("Filter by work item type"),
      state: z.string().optional().describe("Filter by state (e.g., 'Active', 'Closed')"),
      area_path: z.string().optional().describe("Filter to work items UNDER this area path"),
      assigned_to: z.string().optional().describe("Filter by assignee email/display, or '@Me'")
    },
    enabledWhen: (c) =>
      c.azureDevOps.enabled
        ? null
        : "Azure DevOps integration is disabled. Set ADO_ENABLED=true to search work items.",
    run: async (rt, a) => {
      const workItems = await rt.azureDevOpsClient.searchWorkItems({
        text: a.query_text,
        workItemType: a.work_item_type,
        state: a.state,
        areaPath: a.area_path,
        assignedTo: a.assigned_to
      });
      return {
        count: workItems.length,
        workItems: workItems.map((w) => ({
          id: w.id,
          title: w.title,
          workItemType: w.workItemType,
          state: w.state,
          assignedTo: w.assignedTo,
          areaPath: w.areaPath,
          iterationPath: w.iterationPath,
          priority: w.priority,
          storyPoints: w.storyPoints,
          tags: w.tags
        }))
      };
    }
  }),

  defineSpec({
    name: "get_work_item",
    description: "Get a single Azure DevOps work item by its numeric ID",
    schema: {
      id: z.number().int().describe("Work item ID (e.g., 8533637)")
    },
    enabledWhen: adoEnabled,
    run: async (rt, a) => {
      const workItem = await rt.azureDevOpsClient.getWorkItem(a.id);
      if (!workItem) throw new ToolError(`Work item ${a.id} not found`);
      return workItem;
    }
  }),

  defineSpec({
    name: "create_bug_from_incident",
    description:
      "Create an Azure DevOps bug linked to a ServiceNow incident. Includes incident details, priority mapping, and standard acceptance criteria. This is a WRITE action and requires confirmation.",
    write: true,
    schema: {
      incident_number: z.string().describe("Incident to create bug from"),
      title_override: z
        .string()
        .optional()
        .describe("Custom title (default: uses incident short description)"),
      additional_tags: z.array(z.string()).optional().describe("Extra tags to add"),
      area_path: z.string().optional().describe("ADO area path (default: from config)"),
      iteration_path: z.string().optional().describe("ADO iteration path (default: from config)")
    },
    enabledWhen: (c) =>
      !c.azureDevOps.enabled
        ? "ADO integration is disabled. Enable it to create bugs."
        : !c.features.createAdoBug
          ? "ADO bug creation is disabled by feature flag."
          : null,
    run: async (rt, a) => {
      const summary = await rt.incidentService.summarizeIncident(a.incident_number);

      const title =
        a.title_override ?? `[${summary.incident.number}] ${summary.incident.shortDescription}`;
      const description = [
        `ServiceNow Incident: ${summary.incident.number}`,
        `Priority: ${summary.incident.priority}`,
        `Business Service: ${summary.incident.businessService ?? "N/A"}`,
        `Configuration Item: ${summary.incident.cmdbCi ?? "N/A"}`,
        "",
        "## Description",
        summary.incident.description ?? summary.incident.shortDescription,
        "",
        "## Acceptance Criteria",
        "- Root cause is identified and documented",
        "- Mitigation and permanent fix tasks are tracked",
        "- Runbook and monitoring updates are completed"
      ].join("\n");

      const tags = ["ServiceNow", "Incident", "SRE", ...(a.additional_tags ?? [])];

      const created = await rt.azureDevOpsClient.createBug({
        title,
        description,
        areaPath: a.area_path ?? rt.config.azureDevOps.defaultAreaPath,
        iterationPath: a.iteration_path ?? rt.config.azureDevOps.defaultIterationPath,
        tags,
        assignedTeam: rt.config.azureDevOps.defaultAssignedTeam,
        priority: summary.incident.priority,
        incidentNumber: a.incident_number
      });

      return {
        success: true,
        bugId: created.id,
        title: created.title,
        linkedIncident: a.incident_number,
        message: `Bug ${created.id} created successfully`
      };
    }
  }),

  defineSpec({
    name: "create_work_item",
    description:
      "Create an Azure DevOps work item (User Story, Task, Bug, Feature, Epic, Issue) on a board/backlog. Target the board via `board` (friendly name, resolved to an area path) or an explicit `area_path`. Optionally link under a parent work item.",
    write: true,
    schema: {
      type: z
        .enum(["User Story", "Task", "Bug", "Feature", "Epic", "Issue"])
        .describe("Work item type"),
      title: z.string().describe("Work item title"),
      description: z.string().optional().describe("Body/description"),
      board: z
        .string()
        .optional()
        .describe("Friendly board/team name, resolved to an area path via config"),
      area_path: z.string().optional().describe("Explicit ADO area path (overrides board)"),
      iteration_path: z.string().optional().describe("ADO iteration/sprint path"),
      tags: z.array(z.string()).optional().describe("Tags"),
      assigned_to: z.string().optional().describe("Assignee email/display name"),
      priority: z.enum(["1", "2", "3", "4"]).optional().describe("Priority 1 (highest) - 4"),
      story_points: z.number().optional().describe("Story points"),
      parent_id: z.number().optional().describe("Existing work item id to link this under (parent)")
    },
    enabledWhen: adoEnabled,
    run: async (rt, a) => {
      const boardWarning =
        a.board && !a.area_path && !rt.workItemService.isBoardKnown(a.board)
          ? `board "${a.board}" was not found in ADO_BOARD_MAP; used the default area path`
          : undefined;
      const wi = await rt.workItemService.create({
        type: a.type,
        title: a.title,
        description: a.description,
        board: a.board,
        areaPath: a.area_path,
        iterationPath: a.iteration_path,
        tags: a.tags,
        assignedTo: a.assigned_to,
        priority: a.priority,
        storyPoints: a.story_points,
        parentId: a.parent_id
      });
      return {
        success: true,
        id: wi.id,
        title: wi.title,
        type: wi.workItemType,
        areaPath: wi.areaPath,
        parentId: a.parent_id,
        ...(boardWarning ? { boardWarning } : {})
      };
    }
  }),

  defineSpec({
    name: "clone_work_item",
    description:
      "Clone an existing Azure DevOps work item to another board. Carries over fields (title, description, tags, priority, story points, acceptance criteria), resets state to New and clears the assignee. Optionally copies child tasks and adds a Related link back to the source.",
    write: true,
    schema: {
      source_id: z.number().describe("Work item id to clone"),
      board: z.string().optional().describe("Target board/team name, resolved to an area path"),
      area_path: z.string().optional().describe("Explicit target area path (overrides board)"),
      iteration_path: z.string().optional().describe("Target iteration/sprint path"),
      include_children: z.boolean().optional().describe("Copy child tasks too (default false)"),
      link_to_source: z
        .boolean()
        .optional()
        .describe("Add a Related link back to the source (default false)"),
      title_prefix: z
        .string()
        .optional()
        .describe("Prefix prepended to the cloned title (e.g. '[CLONE] ')"),
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
    enabledWhen: adoEnabled,
    run: async (rt, a) => {
      const boardWarning =
        a.board && !a.area_path && !rt.workItemService.isBoardKnown(a.board)
          ? `board "${a.board}" was not found in ADO_BOARD_MAP; used the default area path`
          : undefined;
      const o = a.overrides;
      const res = await rt.workItemService.clone({
        sourceId: a.source_id,
        board: a.board,
        areaPath: a.area_path,
        iterationPath: a.iteration_path,
        includeChildren: a.include_children,
        linkToSource: a.link_to_source,
        titlePrefix: a.title_prefix,
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
      return { success: true, ...res, ...(boardWarning ? { boardWarning } : {}) };
    }
  })
];
```

Registry: add `import { adoSpecs } from "./specs/ado.js";` and extend `TOOL_SPECS`.

- [ ] **Step 4: Run core tests**

Run: `npx vitest run packages/core/tests/tools/registry.test.ts`
Expected: PASS

- [ ] **Step 5: Cut both surfaces over**

- Delete `packages/mcp-server/src/tools/ado.ts`; update barrel + `server.ts` (remove `registerAdoTools`).
- `packages/mcp-server/tests/tools/tools.test.ts`: remove the `registerAdoTools` import/call. Update any `search_work_items` test that passed a required `query_text` or asserted the 6-field projection — the unified spec accepts no `query_text` and returns 10 fields.
- `packages/mcp-server/tests/tools/work-items.test.ts`: replace `registerAdoTools` with `registerRegistryTools` in `connect()` (keep `registerWorkItemCsvTools` — CSV migrates in Task 7). The `makeRuntime` fake already carries `config.azureDevOps.enabled` — MCP behavior tests for create/clone/disabled-guard should pass unchanged; the disabled-guard message for `create_work_item` is unchanged (`"Azure DevOps integration is disabled. Set ADO_ENABLED=true."`).
- `packages/sre-agent/src/tools/index.ts`: remove `search_work_items`, `get_work_item`, `create_bug_from_incident` from `legacyTools` (leaving it EMPTY — keep the empty scaffold; Task 8 deletes it).
- `packages/sre-agent/tests/tools.test.ts`:
  - `fakeRuntime` config gains `azureDevOps.enabled: true` (the new guards read it).
  - The "registers exactly the 15 expected tools" list becomes 17: add `"clone_work_item"` and `"create_work_item"` (CSV tools arrive in Task 7).
  - The skipPermission test's write-tool exclusion becomes the set `["create_bug_from_incident", "create_work_item", "clone_work_item"]`.
  - Add the drift-regression tests:

```ts
  it("create_bug_from_incident errors when ADO is disabled (drift fix)", async () => {
    const rt = fakeRuntime();
    rt.config.azureDevOps.enabled = false;
    const t = byName(rt, "create_bug_from_incident");
    expect(await call(t, { incident_number: "INC1" })).toEqual({
      error: "ADO integration is disabled. Enable it to create bugs."
    });
    expect(rt.azureDevOpsClient.createBug).not.toHaveBeenCalled();
  });

  it("search_work_items errors when ADO is disabled (drift fix)", async () => {
    const rt = fakeRuntime();
    rt.config.azureDevOps.enabled = false;
    const t = byName(rt, "search_work_items");
    expect(await call(t, {})).toEqual({ error: expect.stringMatching(/disabled/) });
  });

  it("search_work_items projects tags (drift fix)", async () => {
    const rt = fakeRuntime();
    rt.azureDevOpsClient.searchWorkItems = vi.fn(async () => [
      { id: 1, title: "t", state: "New", tags: ["a"] }
    ]);
    const t = byName(rt, "search_work_items");
    const out = (await call(t, {})) as any;
    expect(out.workItems[0].tags).toEqual(["a"]);
  });
```

- [ ] **Step 6: Full suite, lint, commit**

Run: `npm run build && npm test && npm run lint && npm run format:check`
Expected: PASS

```bash
git add -A
git commit -m "feat(p1b): migrate ADO group to the registry; fix guard/schema/tool-set drift"
```

---

### Task 7: Migrate the work-item CSV group

**Files:**
- Create: `packages/core/src/tools/specs/workItemCsv.ts`
- Modify: `packages/core/src/tools/registry.ts`, `packages/core/tests/tools/registry.test.ts`
- Modify: `packages/mcp-server/src/server.ts`, `packages/mcp-server/src/tools/index.ts`
- Delete: `packages/mcp-server/src/tools/workItemCsv.ts`
- Modify: `packages/mcp-server/tests/tools/work-items.test.ts` (drop `registerWorkItemCsvTools`)
- Modify: `packages/sre-agent/tests/tools.test.ts` (names list 17 → 19)

**Interfaces:**
- Consumes: `listCsvFiles(dir)`, `readCsvFile(dir, filename, maxBytes)` from `core/src/services/csvReader.ts`; `rt.config.azureDevOps.csvDir` / `.csvMaxBytes`.
- Produces: `workItemCsvSpecs: ToolSpec[]`. Final `TOOL_SPECS` order: incidents, changes, analysis, knowledge, sharepoint, ado, workItemCsv — 19 specs.

- [ ] **Step 1: Write failing registry tests**

Add to `packages/core/tests/tools/registry.test.ts`:

```ts
describe("workItemCsv specs", () => {
  const spec = (n: string) => TOOL_SPECS.find((s) => s.name === n)!;

  it("registers both CSV tools as reads", () => {
    expect(spec("list_work_item_csvs").write).toBeFalsy();
    expect(spec("read_work_item_csv").write).toBeFalsy();
  });

  it("guards on ADO enabled then on csvDir", () => {
    const g = spec("list_work_item_csvs").enabledWhen!;
    expect(g({ azureDevOps: { enabled: false } } as any)).toBe(
      "Azure DevOps integration is disabled. Set ADO_ENABLED=true."
    );
    expect(g({ azureDevOps: { enabled: true, csvDir: undefined } } as any)).toBe(
      "CSV folder not configured. Set ADO_CSV_DIR to a folder of .csv files."
    );
    expect(g({ azureDevOps: { enabled: true, csvDir: "/tmp/csv" } } as any)).toBeNull();
  });

  it("the registry holds exactly the 19 tools", () => {
    expect(TOOL_SPECS.map((s) => s.name).sort()).toEqual(
      [
        "clone_work_item",
        "correlate_changes",
        "create_bug_from_incident",
        "create_work_item",
        "find_sla_risks",
        "find_stale_tickets",
        "generate_ops_summary",
        "get_change",
        "get_incident",
        "get_incident_documents",
        "get_work_item",
        "index_url",
        "list_work_item_csvs",
        "read_work_item_csv",
        "search_changes",
        "search_incidents",
        "search_knowledge",
        "search_work_items",
        "summarize_incident"
      ].sort()
    );
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/core/tests/tools/registry.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `packages/core/src/tools/specs/workItemCsv.ts`**

```ts
import { z } from "zod";
import type { AppConfig } from "../../config.js";
import { listCsvFiles, readCsvFile } from "../../services/csvReader.js";
import { defineSpec } from "../spec.js";

const csvGuard = (c: AppConfig): string | null =>
  !c.azureDevOps.enabled
    ? "Azure DevOps integration is disabled. Set ADO_ENABLED=true."
    : !c.azureDevOps.csvDir
      ? "CSV folder not configured. Set ADO_CSV_DIR to a folder of .csv files."
      : null;

export const workItemCsvSpecs = [
  defineSpec({
    name: "list_work_item_csvs",
    description:
      "List CSV files available in the configured work-item CSV folder (ADO_CSV_DIR). Use read_work_item_csv to load one, then create_work_item / clone_work_item per row.",
    schema: {},
    enabledWhen: csvGuard,
    run: async (rt) => {
      const files = await listCsvFiles(rt.config.azureDevOps.csvDir as string);
      return { files };
    }
  }),

  defineSpec({
    name: "read_work_item_csv",
    description:
      "Read a CSV file from the configured folder (ADO_CSV_DIR) and return its headers and rows as structured JSON. Then detect which rows are stories/tasks and call create_work_item / clone_work_item per row.",
    schema: {
      filename: z.string().describe("CSV filename within ADO_CSV_DIR (no path separators)")
    },
    enabledWhen: csvGuard,
    run: async (rt, a) =>
      readCsvFile(
        rt.config.azureDevOps.csvDir as string,
        a.filename,
        rt.config.azureDevOps.csvMaxBytes
      )
  })
];
```

Registry: add import; final table:

```ts
export const TOOL_SPECS: ToolSpec[] = [
  ...incidentSpecs,
  ...changeSpecs,
  ...analysisSpecs,
  ...knowledgeSpecs,
  ...sharePointSpecs,
  ...adoSpecs,
  ...workItemCsvSpecs
];
```

Surfaces:
- Delete `packages/mcp-server/src/tools/workItemCsv.ts`; update barrel + `server.ts` (remove `registerWorkItemCsvTools` — at this point `server.ts` registers tools with the single `registerRegistryTools` call).
- `packages/mcp-server/tests/tools/work-items.test.ts`: remove the `registerWorkItemCsvTools` import/call (registry covers CSV now). CSV guard-message assertions unchanged.
- `packages/sre-agent/tests/tools.test.ts`: names list 17 → 19 (add `"list_work_item_csvs"`, `"read_work_item_csv"`; both are reads → included in the skipPermission-true loop automatically).

- [ ] **Step 4: Full suite, lint, commit**

Run: `npm run build && npm test && npm run lint && npm run format:check`
Expected: PASS

```bash
git add -A
git commit -m "feat(p1b): migrate work-item CSV group; registry now holds all 19 tools"
```

---

### Task 8: Derive WRITE_TOOLS from the registry + final cleanup

**Files:**
- Modify: `packages/sre-agent/src/engine/permissions.ts`
- Modify: `packages/sre-agent/tests/permissions.test.ts`
- Modify: `packages/sre-agent/src/tools/index.ts` (delete the empty `legacyTools` scaffold)
- Verify-only: `packages/mcp-server/src/server.ts`, `packages/mcp-server/src/tools/index.ts`, `packages/web/server/index.ts`

**Interfaces:**
- Consumes: `WRITE_TOOL_NAMES` from `@sre/core` (Task 1).
- Produces: `makePermissionHandler` — signature UNCHANGED (`engine.ts:127` keeps working).

- [ ] **Step 1: Write the failing permissions test**

In `packages/sre-agent/tests/permissions.test.ts`, add:

```ts
  it("gates every registry write tool, not just create_bug_from_incident", async () => {
    const confirm = vi.fn(async () => true);
    const h = makePermissionHandler({ confirmWrites: true }, confirm);
    for (const toolName of ["create_work_item", "clone_work_item"]) {
      const res = await h({ kind: "custom-tool", toolName, toolDescription: "" } as never);
      expect(res).toEqual({ kind: "approve-once" });
    }
    expect(confirm).toHaveBeenCalledTimes(2);
  });
```

(Match the existing test file's fake-request construction style — mirror how the current tests build the `request` argument.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run packages/sre-agent/tests/permissions.test.ts`
Expected: FAIL — `confirm` called 0 times (the hardcoded set only contains `create_bug_from_incident`)

- [ ] **Step 3: Derive the set**

In `packages/sre-agent/src/engine/permissions.ts` replace:

```ts
/** Tools that mutate external state and must pass the confirm gate. */
const WRITE_TOOLS = new Set(["create_bug_from_incident"]);
```

with:

```ts
import { WRITE_TOOL_NAMES } from "@sre/core";

/** Tools that mutate external state and must pass the confirm gate — derived from the registry. */
const WRITE_TOOLS = WRITE_TOOL_NAMES;
```

(`WRITE_TOOLS.has(...)` call site unchanged — `ReadonlySet` has `has`.)

- [ ] **Step 4: Run permissions tests**

Run: `npx vitest run packages/sre-agent/tests/permissions.test.ts`
Expected: PASS (all pre-existing cases + the new one)

- [ ] **Step 5: Delete the migration scaffolding**

- `packages/sre-agent/src/tools/index.ts`: `legacyTools` is empty since Task 7 — delete it; `buildTools` becomes:

```ts
export const buildTools = (runtime: McpRuntime) =>
  TOOL_SPECS.map((s) => toCopilotTool(s, runtime));
```

Also drop the now-unused `defineTool`-era imports if any remain (`defineTool` stays — the adapter uses it).
- `packages/mcp-server/src/tools/index.ts` must now contain only `export { registerRegistryTools, toMcpHandler } from "./registry.js";`
- Verify no stragglers:

Run: `grep -rn "registerIncidentTools\|registerChangeTools\|registerAnalysisTools\|registerAdoTools\|registerKnowledgeTools\|registerSharePointTools\|registerWorkItemCsvTools" packages/ --include="*.ts" | grep -v node_modules | grep -v dist`
Expected: no matches.

Run: `grep -c "defineTool(" packages/sre-agent/src/tools/index.ts`
Expected: `1` (only inside `toCopilotTool`).

- [ ] **Step 6: Full suite, lint, commit**

Run: `npm run build && npm test && npm run lint && npm run format:check`
Expected: PASS

```bash
git add -A
git commit -m "feat(p1b): derive WRITE_TOOLS from the registry; remove migration scaffolding"
```

---

## Acceptance checklist (whole branch — verify before the PR)

- [ ] Every tool defined exactly once: `grep -rn "server.tool(" packages/mcp-server/src` hits only `tools/registry.ts`; `grep -rn "defineTool(" packages/sre-agent/src` hits only the adapter in `tools/index.ts`.
- [ ] Parity: core registry test pins 19 names; MCP adapter test proves registration name/description/schema === `TOOL_SPECS`; Copilot parity test proves the same for `buildTools`. Both surfaces therefore expose identical tool sets.
- [ ] The three drift bugs have regression tests (Task 6 Step 1 + Step 5; Task 7 names test).
- [ ] `WRITE_TOOL_NAMES` = `{create_bug_from_incident, create_work_item, clone_work_item}`, consumed by `permissions.ts`.
- [ ] Lossy `mapWorkItem` deleted; both ADO clients share `wiql.ts`/`fields.ts`.
- [ ] Net LOC: `mcp-server/src/tools/` shrinks ~940 lines → ~40; `sre-agent/src/tools/index.ts` ~582 → ~45. Spec bodies move to core (defined once).
- [ ] `npm run build && npm test && npm run lint && npm run format:check` green locally; CI 7/7 green on the PR.
