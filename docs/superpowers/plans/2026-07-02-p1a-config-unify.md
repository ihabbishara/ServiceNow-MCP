# P1a: Config Single-Source Unification — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `@sre/core` own the single canonical env schema; have `@sre/sre-agent` extend it and parse `process.env` exactly once; pass the already-built `AppConfig` into `createMcpRuntime` so the env is never parsed twice.

**Architecture:** Split core's `loadConfig` into an exported `envSchema` (zod object) + `buildAppConfig(parsed)` (post-parse + cross-field rules) + `loadConfig(env)` (= `buildAppConfig(envSchema.parse(env))`, unchanged public behavior). The agent builds `agentSchema = envSchema.extend({7 agent-only vars})`, parses ONCE, calls core's `buildAppConfig(parsed)` for its `AppConfig`, keeps its own agent-specific post-parse checks, and returns the `AppConfig` alongside `AgentConfig`. `createMcpRuntime` accepts a prebuilt `AppConfig`. Cross-field business rules stay where they are (core and agent are different apps) — only the schema is unified.

**Tech Stack:** TypeScript 5.6 ESM/NodeNext, zod v4, vitest 2.1.

**Spec:** `docs/superpowers/specs/2026-07-02-enterprise-readiness-roadmap-design.md` §4 P1 (config bullet).

## Global Constraints

- zod v4 across all packages (P0 done). ESM/NodeNext, `strict: true`.
- **Behavior-preserving.** Every existing test must stay green with no assertion changes, EXCEPT where a test asserts the *old two-parse* structure. The one intentional behavior change: the agent's `SERVICENOW_PROXY` becomes URL-validated (core uses `optionalUrl`); if an agent test passes a non-URL proxy it must be updated to a URL (document it).
- One env parse per process. `createMcpRuntime` must NOT re-read `process.env` when handed an `AppConfig`.
- Frequent commits, TDD.
- Branch: `feature/p1a-config-unify`. One PR.

## File Structure

- Modify: `packages/core/src/config.ts` — export `envSchema`, `optional`, `boolString`, `trueBoolString`; extract `buildAppConfig(parsed)`; keep `loadConfig`.
- Modify: `packages/core/src/index.ts` — ensure new exports surface (already `export * from "./config.js"`; verify `envSchema`/`buildAppConfig` are exported values).
- Modify: `packages/core/src/runtime.ts` — `createMcpRuntime` accepts `AppConfig | env`.
- Modify: `packages/sre-agent/src/config.ts` — `agentSchema = envSchema.extend(...)`, parse once, reuse `buildAppConfig`, return `AppConfig` on the result.
- Modify: `packages/sre-agent/src/cli/index.ts` — pass `cfg.app` to `createMcpRuntime`.
- Modify: `packages/web/server/engine-host.ts` (+ `server/index.ts` if it wires runtime) — pass the agent's `app` to `createMcpRuntime`.
- Test: `packages/core/tests/config.test.ts`, `packages/core/tests/runtime.test.ts`, `packages/sre-agent/tests/config.test.ts` (+ a new parity test).

---

### Task 1: Core — export `envSchema` + extract `buildAppConfig`

**Files:**
- Modify: `packages/core/src/config.ts`
- Modify: `packages/core/src/index.ts` (verify exports)
- Test: `packages/core/tests/config.test.ts`

**Interfaces:**
- Produces: `export const envSchema` (the zod object, currently the private `envSchema` const at config.ts:28); `export const buildAppConfig = (e: z.infer<typeof envSchema>): AppConfig => {...}`; `export const optional`, `export const boolString`, `export const trueBoolString`. `loadConfig(env)` unchanged signature/behavior.

- [ ] **Step 1: Add a regression test pinning current behavior**

Add to `packages/core/tests/config.test.ts` (a test that both the split builder and loadConfig agree):
```ts
import { loadConfig, buildAppConfig, envSchema } from "@sre/core";

it("buildAppConfig(envSchema.parse(env)) equals loadConfig(env)", () => {
  const env = { ...validEnv, ADO_ENABLED: "true", ADO_ORG_URL: "https://dev.azure.com/x", ADO_PROJECT: "P" };
  const viaLoad = loadConfig(env);
  const viaBuild = buildAppConfig(envSchema.parse(env));
  expect(viaBuild).toEqual(viaLoad);
});
```
(`validEnv` already exists at the top of this test file.)

- [ ] **Step 2: Run it to verify it fails (exports don't exist yet)**

Run: `npm test -w @sre/core -- config`
Expected: FAIL — `buildAppConfig`/`envSchema` are not exported.

- [ ] **Step 3: Refactor config.ts**

In `packages/core/src/config.ts`:
1. Change `const envSchema = z.object({...})` → `export const envSchema = z.object({...})` (config.ts:28).
2. Add `export` to the helpers `optional` (line 25), `boolString` (line 5), `trueBoolString` (line 9).
3. Extract the body of `loadConfig` AFTER the parse into a new exported function. Replace the current `loadConfig` (lines 201-302) with:
```ts
export const buildAppConfig = (e: z.infer<typeof envSchema>): AppConfig => {
  if (e.ADO_ENABLED) {
    if (!e.ADO_ORG_URL || !e.ADO_PROJECT) {
      throw new Error("ADO_ENABLED=true requires ADO_ORG_URL and ADO_PROJECT");
    }
    if (e.ADO_AUTH_MODE === "pat" && !e.ADO_PAT) {
      throw new Error("ADO_ENABLED=true with ADO_AUTH_MODE=pat requires ADO_PAT");
    }
  }
  if (e.SHAREPOINT_ENABLED && !e.SHAREPOINT_SITE_URL) {
    throw new Error("SHAREPOINT_ENABLED=true requires SHAREPOINT_SITE_URL");
  }
  const seeds = csv(e.CRAWL_SEEDS);
  const allowDomains =
    csv(e.CRAWL_ALLOW_DOMAINS).length > 0
      ? csv(e.CRAWL_ALLOW_DOMAINS)
      : [...new Set(seeds.map(hostOf).filter((h): h is string => !!h))];
  const knowledge: KnowledgeConfig = { /* ...move lines 225-249 verbatim... */ };
  return { /* ...move the returned object lines 250-301 verbatim... */ };
};

export const loadConfig = (env: Record<string, string | undefined> = process.env): AppConfig => {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n  ");
    throw new Error(`Invalid configuration:\n  ${issues}`);
  }
  return buildAppConfig(parsed.data);
};
```
Keep `csv`, `hostOf`, `parseBoardMap` where they are (module scope) — `buildAppConfig` uses them.

- [ ] **Step 4: Verify index.ts re-exports the new values**

`packages/core/src/index.ts:2` is `export * from "./config.js"` — this re-exports the newly-`export`ed `envSchema`/`buildAppConfig`/helpers automatically. No edit needed unless a named export list exists (it doesn't). Confirm by building.

- [ ] **Step 5: Run tests + build**

Run: `npm test -w @sre/core -- config` then `npm run build`
Expected: PASS — the new parity test passes; all existing config tests unchanged and green.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/config.ts packages/core/tests/config.test.ts
git commit -m "refactor(core): export envSchema + extract buildAppConfig from loadConfig

No behavior change — loadConfig = buildAppConfig(envSchema.parse(env)).
Enables the agent to reuse one schema + builder (P1a).

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `createMcpRuntime` accepts a prebuilt `AppConfig`

**Files:**
- Modify: `packages/core/src/runtime.ts`
- Test: `packages/core/tests/runtime.test.ts`

**Interfaces:**
- Consumes: `AppConfig`, `loadConfig` from config.
- Produces: `createMcpRuntime(config?: AppConfig | Record<string, string | undefined>): McpRuntime`. If given an `AppConfig` (detected by a marker field), use it directly; else treat as env and call `loadConfig`. Default `process.env` preserved.

- [ ] **Step 1: Write a test that a prebuilt AppConfig is used without re-parsing**

Add to `packages/core/tests/runtime.test.ts`:
```ts
import { createMcpRuntime, loadConfig } from "@sre/core";

it("accepts a prebuilt AppConfig without re-reading env", () => {
  const cfg = loadConfig(validEnv);           // validEnv already defined in this file
  const rt = createMcpRuntime(cfg);
  expect(rt.config).toBe(cfg);                // same object identity → no re-parse
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -w @sre/core -- runtime`
Expected: FAIL — current signature parses env, so `rt.config` is a new object, not `cfg` (identity differs), or the type rejects an AppConfig arg.

- [ ] **Step 3: Update `createMcpRuntime`**

In `packages/core/src/runtime.ts`, replace the signature + first two lines:
```ts
const isAppConfig = (v: unknown): v is AppConfig =>
  !!v && typeof v === "object" && "serviceNow" in v && "azureDevOps" in v && "knowledge" in v;

export const createMcpRuntime = (
  configOrEnv: AppConfig | Record<string, string | undefined> = process.env
): McpRuntime => {
  const config = isAppConfig(configOrEnv) ? configOrEnv : loadConfig(configOrEnv);
  // ...rest unchanged (uses `config`)...
```
Import `AppConfig` (already imported via `loadConfig, AppConfig` at runtime.ts:1).

- [ ] **Step 4: Run tests + build**

Run: `npm test -w @sre/core -- runtime` then `npm run build`
Expected: PASS; existing runtime tests (which pass env) still green.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/runtime.ts packages/core/tests/runtime.test.ts
git commit -m "feat(core): createMcpRuntime accepts a prebuilt AppConfig (no double parse)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Agent — extend core's schema, parse once, expose `app: AppConfig`

**Files:**
- Modify: `packages/sre-agent/src/config.ts`
- Test: `packages/sre-agent/tests/config.test.ts`

**Interfaces:**
- Consumes: `envSchema`, `buildAppConfig`, `AppConfig` from `@sre/core`.
- Produces: `AgentConfig` gains `app: AppConfig` (replaces the `raw` field). `loadAgentConfig(env)` parses `agentSchema = envSchema.extend({...7 agent-only...})` once, builds `app` via `buildAppConfig(parsed)`, keeps the byok + azcli agent checks.

- [ ] **Step 1: Write the failing test — agent config carries an AppConfig equal to core's**

Add to `packages/sre-agent/tests/config.test.ts`:
```ts
import { loadConfig } from "@sre/core";
import { loadAgentConfig } from "../src/config.js";

it("exposes an AppConfig identical to core loadConfig for the same env", () => {
  const cfg = loadAgentConfig(base);           // `base` already defined in this file
  expect(cfg.app).toEqual(loadConfig(base));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -w @sre/sre-agent -- config`
Expected: FAIL — `AgentConfig` has no `app` field.

- [ ] **Step 3: Rewrite `packages/sre-agent/src/config.ts`**

```ts
import { z } from "zod";
import { envSchema, buildAppConfig, optional, type AppConfig } from "@sre/core";

const bool = (def: boolean) =>
  z.enum(["true", "false"]).default(def ? "true" : "false").transform((v) => v === "true");

// Core owns the shared vars; the agent adds only its own.
const agentSchema = envSchema.extend({
  COPILOT_GITHUB_TOKEN: optional(z.string()),
  COPILOT_HOME: optional(z.string()),
  COPILOT_IGNORE_ENV_TOKEN: bool(true),
  CONFIRM_WRITES: bool(true),
  TURN_TIMEOUT_MS: z.coerce.number().int().positive().default(300000),
  CRAWL_TTL_HOURS: z.coerce.number().nonnegative().default(24),
  UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(10485760)
});

export interface AgentConfig {
  llm: { mode: "seat" | "byok"; model: string; provider?: { type: "azure" | "anthropic" | "openai"; baseUrl: string; apiKey?: string; apiVersion?: string } };
  adoAuthMode: "azcli" | "pat";
  confirmWrites: boolean;
  turnTimeoutMs: number;
  knowledgeEnabled: boolean;
  crawlTtlHours: number;
  uploadMaxBytes: number;
  sharePointEnabled: boolean;
  copilot: { githubToken?: string; home?: string; ignoreEnvToken: boolean };
  /** The core AppConfig built from the SAME single parse — pass to createMcpRuntime. */
  app: AppConfig;
}

export const loadAgentConfig = (env: Record<string, string | undefined> = process.env): AgentConfig => {
  const parsed = agentSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n  ");
    throw new Error(`Invalid configuration:\n  ${issues}`);
  }
  const e = parsed.data;
  if (e.LLM_MODE === "byok" && (!e.LLM_PROVIDER || !e.LLM_BASE_URL)) {
    throw new Error("LLM_MODE=byok requires LLM_PROVIDER and LLM_BASE_URL");
  }
  if (e.ADO_AUTH_MODE === "azcli" && (!e.ADO_ORG_URL || !e.ADO_PROJECT)) {
    throw new Error("ADO_AUTH_MODE=azcli requires ADO_ORG_URL and ADO_PROJECT");
  }
  return {
    llm: {
      mode: e.LLM_MODE,
      model: e.LLM_MODEL,
      provider: e.LLM_PROVIDER
        ? { type: e.LLM_PROVIDER, baseUrl: e.LLM_BASE_URL!, apiKey: e.LLM_API_KEY, apiVersion: e.AZURE_API_VERSION }
        : undefined
    },
    adoAuthMode: e.ADO_AUTH_MODE,
    confirmWrites: e.CONFIRM_WRITES,
    turnTimeoutMs: e.TURN_TIMEOUT_MS,
    knowledgeEnabled: !!(e.CRAWL_SEEDS && String(e.CRAWL_SEEDS).trim()),
    crawlTtlHours: e.CRAWL_TTL_HOURS,
    uploadMaxBytes: e.UPLOAD_MAX_BYTES,
    sharePointEnabled: e.SHAREPOINT_ENABLED,
    copilot: { githubToken: e.COPILOT_GITHUB_TOKEN, home: e.COPILOT_HOME, ignoreEnvToken: e.COPILOT_IGNORE_ENV_TOKEN },
    app: buildAppConfig(e)
  };
};
```
Note: `buildAppConfig(e)` receives the extended parsed object; extra agent-only keys are harmless (buildAppConfig only reads core keys). `e.CRAWL_SEEDS` now comes from the parsed core schema (was `env.CRAWL_SEEDS`), equivalent.

- [ ] **Step 4: Update any test that relied on `raw`**

Search: `grep -rn "\.raw" packages/sre-agent/src packages/sre-agent/tests packages/web`. If `.raw` was consumed anywhere, replace with the equivalent field on `app` or the parsed value. (Expected: `raw` was only used to hand env to core — now `app` replaces it.)

- [ ] **Step 5: Run agent config tests + build**

Run: `npm test -w @sre/sre-agent -- config` then `npm run build`
Expected: PASS. If a test fails because `SERVICENOW_PROXY` is now URL-validated, update that test's proxy value to a valid URL (this is the one documented intentional tightening).

- [ ] **Step 6: Commit**

```bash
git add packages/sre-agent/src/config.ts packages/sre-agent/tests/config.test.ts
git commit -m "refactor(agent): extend core envSchema, parse once, expose app: AppConfig

Removes the duplicate ~24-var schema; agent now declares only its 7 own vars.
Kills the 'config ok then core throws' double-parse gap.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Wire call sites to the single parse (drop the double parse)

**Files:**
- Modify: `packages/sre-agent/src/cli/index.ts` (~line 140 `loadAgentConfig`, ~164 `createMcpRuntime`)
- Modify: `packages/web/server/engine-host.ts` (and `packages/web/server/index.ts` if it constructs the runtime)
- Test: `packages/sre-agent/tests/config.test.ts` or a small integration test

**Interfaces:**
- Consumes: `AgentConfig.app` from Task 3; `createMcpRuntime(AppConfig)` from Task 2.

- [ ] **Step 1: Find every `createMcpRuntime` call site**

Run: `grep -rn "createMcpRuntime" packages/sre-agent/src packages/web`
Expected sites: `sre-agent/src/cli/index.ts`, `web/server/index.ts` or `engine-host.ts`. Note each — currently they call `createMcpRuntime()` (re-reading env) after `loadAgentConfig()` already parsed.

- [ ] **Step 2: Update the CLI**

In `packages/sre-agent/src/cli/index.ts`: where it does `const config = loadAgentConfig(...)` then later `createMcpRuntime()`, change the runtime call to `createMcpRuntime(config.app)`. Do not change the `loadAgentConfig` call.

- [ ] **Step 3: Update the web engine host**

In `packages/web/server/engine-host.ts` (and/or `server/index.ts`): the runtime is built via `runtimeFactory` / `createMcpRuntime`. Pass the loaded agent config's `app`. Trace where `loadAgentConfig` result flows and hand its `.app` to `createMcpRuntime`. (Web loads dotenv → `createMcpRuntime` → `loadAgentConfig` today; reorder so `loadAgentConfig` runs first and its `.app` feeds `createMcpRuntime`.)

- [ ] **Step 4: Add a parse-count guard test**

Add to `packages/sre-agent/tests/config.test.ts`:
```ts
it("loadAgentConfig produces an app usable by createMcpRuntime without a second parse", async () => {
  const { createMcpRuntime } = await import("@sre/core");
  const cfg = loadAgentConfig(base);
  const rt = createMcpRuntime(cfg.app);
  expect(rt.config).toBe(cfg.app);   // identity → single parse
});
```

- [ ] **Step 5: Full build + full test suite**

Run: `npm run build && npm test`
Expected: all packages build; full suite green (P0 baseline 448 + the new P1a tests). No web/CLI test regressions.

- [ ] **Step 6: Commit**

```bash
git add packages/sre-agent/src/cli/index.ts packages/web/server packages/sre-agent/tests/config.test.ts
git commit -m "refactor: feed AgentConfig.app into createMcpRuntime (single env parse, CLI + web)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage (§4 P1 config bullet):** "core owns the schema; sre-agent .extend()s it; parse process.env once; createMcpRuntime(config)" → Task 1 (core owns/exports schema + builder), Task 3 (agent extends + parses once), Task 2 + Task 4 (createMcpRuntime takes AppConfig; call sites feed it). ✓ "drop the re-read at runtime.ts:28-29" → Task 2. ✓

**Placeholder scan:** Task 1 Step 3 says "move lines 225-249 / 250-301 verbatim" — this is a mechanical move of existing, in-context code, not a placeholder; the surrounding new function bodies are shown in full. All test code is concrete. No "handle edge cases". ✓

**Type consistency:** `envSchema`, `buildAppConfig`, `AppConfig`, `AgentConfig.app`, `createMcpRuntime(AppConfig | env)` names are consistent across Tasks 1–4. The `isAppConfig` guard keys on `serviceNow`/`azureDevOps`/`knowledge` — fields present on `AppConfig` (config.ts:159-162). ✓

**Behavior notes for the executor:** (1) The only intentional behavior change is agent `SERVICENOW_PROXY` gaining URL validation (core's `optionalUrl`) — update any agent test that used a non-URL proxy. (2) Agent's azcli/byok cross-field checks are PRESERVED (not merged into core) — core and agent remain independent apps. (3) The audit's "un-guarded Copilot ADO tools call a disabled client" is a TOOL-guard issue handled in **P1b** (registry `enabledWhen`), NOT here.
