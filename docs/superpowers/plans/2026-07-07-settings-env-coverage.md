# Settings Env Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every cataloged env var is always visible in the web Settings tab (empty when unset), the catalog covers all real vars incl. `GIT_WORKSPACE_DIR`, and saving never spams `KEY=""` lines into `.env`.

**Architecture:** Pure helpers in `env-fields.ts` (`visibleKeys` union, `varsToSave` filter) + catalog completion; `EnvSettings.tsx` swaps its key source and save payload; a drift-guard test pins catalog completeness against the core `envSchema` plus the agent-only keys.

**Tech Stack:** React (web client), vitest, zod envSchema from `@sre/core`.

**Spec:** `docs/superpowers/specs/2026-07-07-settings-env-coverage-design.md`

## Global Constraints

- Cataloged fields always visible per group: catalog declaration order first, uncataloged file-only extras after.
- `varsToSave` drops entries with `value === ""` whose key was NOT in the originally-loaded file; keeps empty values for originally-present keys (clear semantics preserved); keeps all non-empty values.
- New catalog entries (10): `GIT_WORKSPACE_DIR`, `ADO_BOARD_MAP`, `ADO_CSV_DIR`, `ADO_CSV_MAX_BYTES` (Azure DevOps); `SHAREPOINT_MAX_DOC_TOKENS`, `SHAREPOINT_MAX_FILES`, `SHAREPOINT_MAX_FILE_BYTES`, `SHAREPOINT_TIMEOUT_MS` (SharePoint); `COPILOT_CLI_PATH` (LLM & Copilot); `WEB_PORT` (Other). Descriptions must state the defaults given in Task 1's code.
- Drift guard: every `Object.keys(envSchema.shape)` key + the agent-only list (`WEB_PORT`, `COPILOT_CLI_PATH`, `TURN_TIMEOUT_MS`, `CONFIRM_WRITES`, `COPILOT_GITHUB_TOKEN`, `COPILOT_HOME`, `COPILOT_IGNORE_ENV_TOKEN`, `CRAWL_TTL_HOURS`, `UPLOAD_MAX_BYTES`) must have an `ENV_FIELDS` entry.
- No server changes (`readEnv`/`applyEnv` contracts untouched).
- Run from repo root `/Users/ihabbishara/projects/ServiceNowMCP`; lint-clean before commit.

---

### Task 1: Catalog completion + `visibleKeys`/`varsToSave` + drift guard

**Files:**
- Modify: `packages/web/client/src/views/env-fields.ts`
- Test: `packages/web/tests/env-fields.test.ts` (extend existing)

**Interfaces:**
- Consumes: existing `ENV_FIELDS`, `EnvGroup`, `groupOf`.
- Produces (Task 2 relies on):
  - `visibleKeys(group: EnvGroup, fileKeys: string[]): string[]`
  - `varsToSave(vars: Record<string, string>, originalKeys: string[]): Record<string, string>`
  - 10 new `ENV_FIELDS` entries listed in Global Constraints.

- [ ] **Step 1: Write the failing tests**

Append to `packages/web/tests/env-fields.test.ts` (match its existing import style; add `visibleKeys`, `varsToSave`, `ENV_FIELDS` to the import):

```ts
import { envSchema } from "@sre/core";

describe("catalog completeness (drift guard)", () => {
  const AGENT_ONLY_KEYS = [
    "WEB_PORT",
    "COPILOT_CLI_PATH",
    "TURN_TIMEOUT_MS",
    "CONFIRM_WRITES",
    "COPILOT_GITHUB_TOKEN",
    "COPILOT_HOME",
    "COPILOT_IGNORE_ENV_TOKEN",
    "CRAWL_TTL_HOURS",
    "UPLOAD_MAX_BYTES"
  ];
  for (const key of [...Object.keys(envSchema.shape), ...AGENT_ONLY_KEYS]) {
    it(`catalogs ${key}`, () => {
      expect(ENV_FIELDS[key], key).toBeDefined();
      expect(ENV_FIELDS[key].description.length).toBeGreaterThan(10);
    });
  }

  it("puts GIT_WORKSPACE_DIR in the Azure DevOps group", () => {
    expect(ENV_FIELDS.GIT_WORKSPACE_DIR.group).toBe("Azure DevOps");
    expect(ENV_FIELDS.GIT_WORKSPACE_DIR.description).toMatch(/temp dir/i);
  });
});

describe("visibleKeys", () => {
  it("returns catalog keys for a group even when the file has none", () => {
    const keys = visibleKeys("Azure DevOps", []);
    expect(keys).toContain("GIT_WORKSPACE_DIR");
    expect(keys).toContain("ADO_ORG_URL");
  });

  it("orders catalog keys first (declaration order), file-only extras after", () => {
    const keys = visibleKeys("Other", ["MY_CUSTOM_FLAG"]);
    expect(keys.at(-1)).toBe("MY_CUSTOM_FLAG");
    expect(keys.indexOf("CONFIRM_WRITES")).toBeLessThan(keys.indexOf("MY_CUSTOM_FLAG"));
  });

  it("does not duplicate a cataloged key that is also in the file", () => {
    const keys = visibleKeys("Azure DevOps", ["ADO_ORG_URL"]);
    expect(keys.filter((k) => k === "ADO_ORG_URL")).toHaveLength(1);
  });

  it("does not leak uncataloged file keys into non-Other groups", () => {
    expect(visibleKeys("ServiceNow", ["MY_CUSTOM_FLAG"])).not.toContain("MY_CUSTOM_FLAG");
  });
});

describe("varsToSave", () => {
  it("drops empty values for keys not originally in the file", () => {
    expect(varsToSave({ GIT_WORKSPACE_DIR: "", ADO_PROJECT: "IngOne" }, ["ADO_PROJECT"])).toEqual({
      ADO_PROJECT: "IngOne"
    });
  });

  it("keeps an emptied value for a key the user is clearing (originally present)", () => {
    expect(varsToSave({ ADO_PAT: "" }, ["ADO_PAT"])).toEqual({ ADO_PAT: "" });
  });

  it("keeps all non-empty values regardless of origin", () => {
    expect(varsToSave({ GIT_WORKSPACE_DIR: "/var/tmp/repos" }, [])).toEqual({
      GIT_WORKSPACE_DIR: "/var/tmp/repos"
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/web/tests/env-fields.test.ts`
Expected: FAIL — 10 `catalogs <key>` cases (missing entries) + `visibleKeys`/`varsToSave` not exported.

- [ ] **Step 3: Implement in `packages/web/client/src/views/env-fields.ts`**

1. Add the 10 catalog entries (each in its group's section of `ENV_FIELDS`):

```ts
  // (Azure DevOps section)
  ADO_BOARD_MAP: {
    label: "Board map",
    description: 'JSON map of board name → area path, e.g. {"BoardName":"Area\\\\Path"}. Invalid JSON is ignored.',
    group: "Azure DevOps"
  },
  ADO_CSV_DIR: {
    label: "Work-item CSV folder",
    description: "Folder of work-item CSV files the list/read CSV tools may ingest.",
    group: "Azure DevOps"
  },
  ADO_CSV_MAX_BYTES: {
    label: "Max CSV bytes",
    description: "Max CSV file size read into memory (default 5 MB).",
    group: "Azure DevOps"
  },
  GIT_WORKSPACE_DIR: {
    label: "Git workspace dir",
    description:
      "Directory for incident-analysis repo checkouts (default: OS temp dir, auto-cleaned by the OS). Clones are shallow and read-only.",
    group: "Azure DevOps"
  },
```

```ts
  // (SharePoint section)
  SHAREPOINT_MAX_DOC_TOKENS: {
    label: "Max doc tokens",
    description: "Inline text budget across all extracted documents (default 50000).",
    group: "SharePoint"
  },
  SHAREPOINT_MAX_FILES: {
    label: "Max files",
    description: "Cap on files walked per incident folder (default 50).",
    group: "SharePoint"
  },
  SHAREPOINT_MAX_FILE_BYTES: {
    label: "Max file bytes",
    description: "Skip documents larger than this (default 10 MB).",
    group: "SharePoint"
  },
  SHAREPOINT_TIMEOUT_MS: {
    label: "Timeout (ms)",
    description: "Per-request timeout for SharePoint/Graph calls (default 30000).",
    group: "SharePoint"
  },
```

```ts
  // (LLM & Copilot section)
  COPILOT_CLI_PATH: {
    label: "Copilot CLI path",
    description: "Override path to the Copilot SDK CLI runtime binary.",
    group: "LLM & Copilot"
  },
```

```ts
  // (Other section)
  WEB_PORT: {
    label: "Web UI port",
    description: "Port for the local web UI, bound to 127.0.0.1 (default 4317).",
    group: "Other"
  },
```

2. Add the helpers at the bottom of the file:

```ts
/** Union of catalog + file keys for one group: catalog declaration order first, file-only extras after. */
export const visibleKeys = (group: EnvGroup, fileKeys: string[]): string[] => {
  const catalog = Object.keys(ENV_FIELDS).filter((k) => ENV_FIELDS[k].group === group);
  const extras = fileKeys.filter((k) => !(k in ENV_FIELDS) && groupOf(k) === group);
  return [...catalog, ...extras];
};

/**
 * Save payload without churn: drop empty values for keys that were not in the
 * originally-loaded file (avoids appending KEY="" lines), keep empty values for
 * originally-present keys (the user is clearing them), keep all non-empty values.
 */
export const varsToSave = (
  vars: Record<string, string>,
  originalKeys: string[]
): Record<string, string> => {
  const original = new Set(originalKeys);
  return Object.fromEntries(
    Object.entries(vars).filter(([k, v]) => v !== "" || original.has(k))
  );
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/web/tests/env-fields.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint and commit**

```bash
npx eslint packages/web/client/src/views/env-fields.ts packages/web/tests/env-fields.test.ts
git add packages/web/client/src/views/env-fields.ts packages/web/tests/env-fields.test.ts
git commit -m "feat(web): complete env catalog + visibleKeys/varsToSave helpers with drift guard"
```

---

### Task 2: EnvSettings union rendering + no-churn save

**Files:**
- Modify: `packages/web/client/src/views/EnvSettings.tsx` (component body, lines ~87-153)

**Interfaces:**
- Consumes: `visibleKeys(group, fileKeys)`, `varsToSave(vars, originalKeys)` (Task 1).
- Produces: none (leaf view change; behavior covered by Task 1's pure-helper tests — the view has no test file, matching the existing pattern).

- [ ] **Step 1: Implement**

In `packages/web/client/src/views/EnvSettings.tsx`:

1. Extend the imports from `./env-fields.js` with `visibleKeys, varsToSave`.
2. Track the originally-loaded keys:

```tsx
  const [vars, setVars] = useState<Record<string, string>>({});
  const [originalKeys, setOriginalKeys] = useState<string[]>([]);
```

and in the load effect:

```tsx
      .then((r) => {
        setVars(r.vars);
        setOriginalKeys(Object.keys(r.vars));
        setComments(r.comments ?? {});
      })
```

3. Save with the filtered payload:

```tsx
      const res = await putEnv(varsToSave(vars, originalKeys));
```

4. Render the union per group (replaces the `Object.keys(vars).filter(...)` line; the `keys.length === 0` guard stays for safety but cataloged groups are now never empty):

```tsx
          const keys = visibleKeys(group, Object.keys(vars));
```

5. Unset keys render empty:

```tsx
                    value={vars[k] ?? ""}
```

- [ ] **Step 2: Run the web test suite + typecheck**

Run: `npx vitest run packages/web/tests/ && npm run typecheck`
Expected: PASS / clean — no view test exists; helpers are covered; typecheck confirms the wiring.

- [ ] **Step 3: Lint and commit**

```bash
npx eslint packages/web/client/src/views/EnvSettings.tsx
git add packages/web/client/src/views/EnvSettings.tsx
git commit -m "feat(web): always show cataloged settings fields; no-churn env save"
```

---

### Task 3: Full verification

**Files:** none new — whole-workspace gates.

- [ ] **Step 1: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: clean exit (includes the Vite client build).

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: all packages green.

- [ ] **Step 3: Lint + format**

Run: `npm run lint && npm run format:check`
Expected: lint 0 errors (pre-existing warnings tolerated). If format:check fails on changed files, `npm run format`, re-run all gates.

- [ ] **Step 4: Commit fixups only if any exist**

```bash
git add -A
git commit -m "chore: verification fixups for settings env coverage"
```
