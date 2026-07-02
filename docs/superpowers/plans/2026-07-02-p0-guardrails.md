# P0 Guardrails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the CI, lint/format, single-zod-version, and repo-hygiene guardrails that backstop every later phase (P1–P3) of the enterprise-readiness roadmap.

**Architecture:** Non-invasive foundation layer. No product-logic changes except the mechanical zod v3→v4 migration in `@sre/core` + `@sre/mcp-server`. Everything else is new config files (CI, ESLint, Prettier, hygiene) and regenerating the stale `.env.example`. All work lands on one branch `feature/p0-guardrails` as one PR.

**Tech Stack:** npm workspaces, TypeScript 5.6 (ESM/NodeNext), vitest 2.1, zod, ESLint 9 (flat config) + `typescript-eslint`, Prettier 3, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-07-02-enterprise-readiness-roadmap-design.md` (§4 P0).

## Global Constraints

- Node engines: `^20.19 || >=22.12` (root `package.json:6`). CI matrix: Node 20 + 22.
- Module system: ESM everywhere (`"type":"module"`), TS `module`/`moduleResolution` = `NodeNext`, `target` ES2022 (`tsconfig.base.json`).
- Single zod major after this phase: **zod v4** in all three code packages (`core`, `mcp-server`, `sre-agent`). sre-agent is already `zod@4.4.3`; MCP SDK `@modelcontextprotocol/sdk@1.29.0` accepts `^3.25 || ^4.0` (verified) so v4 is compatible.
- `strict: true` stays on; do not weaken it.
- No product-behavior changes in P0 — every existing test must still pass unchanged (except mechanical zod-API edits).
- Frequent commits; TDD where logic is touched. Config-file tasks verify by running the tool.

## File Structure

- Create: `.github/workflows/ci.yml` — build + test + lint on Node 20/22 × {ubuntu, macos, windows}.
- Create: `eslint.config.js` (flat config, root) — lint rules for all packages.
- Create: `.prettierrc.json`, `.prettierignore` — format config.
- Create: `.nvmrc` — pin Node for local dev.
- Create: `tsconfig.json` (root solution file) — single `tsc -b` entrypoint referencing all packages.
- Create: `LICENSE`, `SECURITY.md`, `.editorconfig`.
- Modify: `package.json` (root) — add `lint`, `lint:fix`, `format`, `format:check`, `typecheck` scripts + devDeps.
- Modify: `packages/core/package.json`, `packages/mcp-server/package.json` — bump `zod` to `^4.4.3`.
- Modify: `packages/core/src/config.ts` (+ any other v3-API call sites surfaced by the build) — zod v4 API fixes.
- Modify: `packages/sre-agent/.env.example` — add the 5 undocumented vars.
- Modify: `.gitignore` — add `.superpowers/`.

---

### Task 0: Branch + baseline green

**Files:** none (setup).

- [ ] **Step 1: Create the phase branch**

```bash
cd /Users/ihabbishara/projects/ServiceNowMCP
git checkout main && git pull --ff-only
git checkout -b feature/p0-guardrails
```

- [ ] **Step 2: Establish a green baseline**

Run: `npm ci && npm run build && npm test`
Expected: build succeeds for all 4 packages; vitest reports all tests passing (70 test files). If anything fails on a clean checkout, STOP and report — the baseline must be green before changing anything.

---

### Task 1: Migrate `@sre/core` + `@sre/mcp-server` to zod v4

**Files:**
- Modify: `packages/core/package.json:28` (zod dep)
- Modify: `packages/mcp-server/package.json:12` (zod dep)
- Modify: `packages/core/src/config.ts` (v3→v4 API call sites)
- Modify: any other file the build flags (candidates: `mcp-server/src/tools/*.ts`, `mcp-server/src/prompts/index.ts` — all `import { z } from "zod"`)

**Interfaces:**
- Produces: all packages resolve to `zod@4.x`; `loadConfig(env)` keeps its exact current signature and return shape (`AppConfig`) — no behavior change, only API syntax.

- [ ] **Step 1: Bump the zod dependency in both packages**

Edit `packages/core/package.json`: change `"zod": "^3.24.0"` → `"zod": "^4.4.3"`.
Edit `packages/mcp-server/package.json`: change `"zod": "^3.24.0"` → `"zod": "^4.4.3"`.

- [ ] **Step 2: Reinstall and dedupe**

Run: `npm install`
Then: `npm ls zod --workspaces`
Expected: `core`, `mcp-server`, `sre-agent` all show `zod@4.4.x` (single major across the tree).

- [ ] **Step 3: Build and capture v4 API breakages**

Run: `npm run build`
Expected: `tsc -b` may emit errors from zod v4 API changes. The known v4 breakages that apply to this codebase and their fixes:
  - `z.string().url()` → `z.url()` (top-level string-format validators moved out of `ZodString`). Same for `.email()`, `.uuid()` if present.
  - `z.record(valueSchema)` (single arg) → `z.record(z.string(), valueSchema)` (v4 requires an explicit key schema).
  - Custom error messages: `{ message: "..." }` on refinements is unchanged, but a top-level `errorMap` on `.parse` options → `{ error: fn }`. Only fix if a call site uses it.
  - `.default()` placement and `ZodDefault` unwrapping are unchanged for this code.
Fix each error the compiler reports in `packages/core/src/config.ts` (and any flagged mcp file) using the mappings above. Do NOT change validation semantics — only syntax.

- [ ] **Step 4: Re-run build until clean**

Run: `npm run build`
Expected: PASS (all 4 packages compile).

- [ ] **Step 5: Run the full test suite**

Run: `npm test`
Expected: PASS with the same test count as the Task 0 baseline. The config tests (`packages/core/tests/config.test.ts` if present, plus `sre-agent` config tests) exercise the migrated schema — they must stay green with no assertion edits. If a test fails, the migration changed behavior; fix the code, not the test.

- [ ] **Step 6: Commit**

```bash
git add packages/core/package.json packages/mcp-server/package.json packages/core/src packages/mcp-server/src package-lock.json
git commit -m "chore(deps): migrate core + mcp-server to zod v4

Single zod major across the tree (sre-agent already v4; MCP SDK 1.29
accepts ^3.25||^4.0). Mechanical API fixes only, no validation changes.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: ESLint (flat config) + Prettier

**Files:**
- Create: `eslint.config.js`
- Create: `.prettierrc.json`
- Create: `.prettierignore`
- Create: `.editorconfig`
- Modify: `package.json` (root) — devDeps + scripts

**Interfaces:**
- Produces: `npm run lint`, `npm run lint:fix`, `npm run format`, `npm run format:check`, `npm run typecheck` scripts that CI (Task 5) calls.

- [ ] **Step 1: Install lint/format devDependencies**

Run:
```bash
npm install -D -w . eslint@^9 typescript-eslint@^8 @eslint/js@^9 prettier@^3 eslint-config-prettier@^9
```
Expected: added to root `devDependencies`.

- [ ] **Step 2: Create `eslint.config.js` (flat config)**

```js
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/*.tsbuildinfo", "packages/web/client/dist/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Pragmatic starting posture — tighten in later phases, don't block P0 on churn.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-console": "off"
    }
  },
  {
    files: ["**/*.test.ts", "**/tests/**"],
    rules: { "@typescript-eslint/no-explicit-any": "off" }
  }
);
```
<!-- ponytail: rules start lenient (any=warn); P2 tightens once the registry refactor stops churning files. -->

- [ ] **Step 3: Create `.prettierrc.json`**

```json
{
  "printWidth": 100,
  "semi": true,
  "singleQuote": false,
  "trailingComma": "none"
}
```
<!-- Matches the existing code style seen in core/*.ts (double quotes, semicolons, ~100 col). -->

- [ ] **Step 4: Create `.prettierignore`**

```
**/dist/**
**/*.tsbuildinfo
package-lock.json
docs/**
*.md
```

- [ ] **Step 5: Create `.editorconfig`**

```ini
root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
indent_style = space
indent_size = 2
trim_trailing_whitespace = true
```

- [ ] **Step 6: Add scripts to root `package.json`**

Add to the `scripts` block:
```json
    "typecheck": "tsc -b",
    "lint": "eslint .",
    "lint:fix": "eslint . --fix",
    "format": "prettier --write .",
    "format:check": "prettier --check ."
```

- [ ] **Step 7: Auto-fix, then assess remaining lint errors**

Run: `npm run lint:fix` then `npm run format`
Then: `npm run lint`
Expected: zero errors (warnings allowed). If real errors remain (e.g. genuine unused vars), fix them minimally in source — do NOT disable rules wholesale. If a rule proves too noisy for P0, downgrade that ONE rule to `"warn"` in `eslint.config.js` with a `ponytail:` comment naming why.

- [ ] **Step 8: Verify build + tests still pass after formatting**

Run: `npm run build && npm test`
Expected: PASS (formatting must not change behavior).

- [ ] **Step 9: Commit**

```bash
git add eslint.config.js .prettierrc.json .prettierignore .editorconfig package.json package-lock.json .
git commit -m "chore: add ESLint (flat) + Prettier + editorconfig with scripts

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Repo hygiene files

**Files:**
- Create: `.nvmrc`
- Create: `tsconfig.json` (root solution)
- Create: `LICENSE`
- Create: `SECURITY.md`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `tsc -b` at the repo root builds all packages in dependency order (used by `npm run typecheck`).

- [ ] **Step 1: Create `.nvmrc`**

```
22
```

- [ ] **Step 2: Create root `tsconfig.json` solution file**

```json
{
  "files": [],
  "references": [
    { "path": "packages/core" },
    { "path": "packages/mcp-server" },
    { "path": "packages/sre-agent" },
    { "path": "packages/web" }
  ]
}
```

- [ ] **Step 3: Verify the root solution builds**

Run: `tsc -b`
Expected: PASS — builds all four packages in reference order. (This is what `npm run typecheck` now runs.)

- [ ] **Step 4: Add `.superpowers/` to `.gitignore`**

Append to `.gitignore`:
```
.superpowers/
```

- [ ] **Step 5: Create `SECURITY.md`**

```markdown
# Security Policy

## Reporting a vulnerability

This is an internal SRE tool run locally per-engineer. To report a security
issue, contact the repository owner directly (do not open a public issue).

## Security posture

- Runs locally per-SRE; auth reuses the developer's `az login` + GitHub Copilot
  seat. Secrets live in a local `.env` (chmod 600), never committed.
- The web UI binds to `127.0.0.1` only and is single-user (see
  `packages/web/README.md`). It is not hardened for shared hosting; hardening
  is tracked in the enterprise-readiness roadmap (P2).
- Subprocess calls to `az`/`git` use `execFile` argument arrays (no shell).
```

- [ ] **Step 6: Create `LICENSE`**

Add the license the owner intends. Default to a `UNLICENSED`/proprietary notice for an internal tool:
```
Copyright (c) 2026. All rights reserved.

This software is proprietary and confidential. Unauthorized copying,
distribution, or use is prohibited.
```
<!-- ponytail: if the owner wants MIT/Apache instead, swap the file; the CI/hygiene tasks don't depend on the license text. -->

- [ ] **Step 7: Commit**

```bash
git add .nvmrc tsconfig.json LICENSE SECURITY.md .gitignore
git commit -m "chore: repo hygiene (nvmrc, root tsconfig solution, LICENSE, SECURITY.md)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Regenerate `.env.example` (fix documentation drift)

**Files:**
- Modify: `packages/sre-agent/.env.example`

**Interfaces:**
- Consumes: the canonical env var list in `packages/core/src/config.ts` (schema) + `packages/sre-agent/src/config.ts`.

- [ ] **Step 1: Write a failing check that `.env.example` documents every schema var**

Create `packages/core/tests/env-example.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The canonical .env.example ships in the sre-agent package.
const envExamplePath = fileURLToPath(
  new URL("../../sre-agent/.env.example", import.meta.url)
);

// Vars read by the app that MUST be documented in .env.example.
// (Audit found these 5 missing as of 2026-07-02.)
const REQUIRED_DOCUMENTED = [
  "ADO_BOARD_MAP",
  "ADO_CSV_DIR",
  "ADO_CSV_MAX_BYTES",
  "COPILOT_CLI_PATH",
  "WEB_PORT"
];

describe(".env.example completeness", () => {
  const text = readFileSync(envExamplePath, "utf8");
  for (const key of REQUIRED_DOCUMENTED) {
    it(`documents ${key}`, () => {
      expect(text).toMatch(new RegExp(`^\\s*#?\\s*${key}=`, "m"));
    });
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test -w @sre/core -- env-example`
Expected: FAIL — the 5 keys are not present in `.env.example`.

- [ ] **Step 3: Add the missing vars to `.env.example`**

Append a documented block to `packages/sre-agent/.env.example` (use the defaults from `core/src/config.ts:33-35` and the web port default `4317`):
```bash
# --- Azure DevOps: board mapping + CSV ingestion (optional) ---
ADO_BOARD_MAP=                                       # JSON: {"BoardName":"Area\\Path"}; invalid JSON is ignored
ADO_CSV_DIR=                                         # folder of work-item CSVs for list/read tools
ADO_CSV_MAX_BYTES=5242880                            # max CSV size read into memory

# --- Copilot / web (optional) ---
COPILOT_CLI_PATH=                                    # override path to the Copilot SDK CLI runtime
WEB_PORT=4317                                        # port for the local web UI (127.0.0.1 only)
```

- [ ] **Step 4: Run the check to verify it passes**

Run: `npm test -w @sre/core -- env-example`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sre-agent/.env.example packages/core/tests/env-example.test.ts
git commit -m "docs: document 5 missing env vars + add .env.example completeness test

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: root scripts `build`, `test`, `lint`, `format:check`, `typecheck` (Tasks 2–3).

- [ ] **Step 1: Create `.github/workflows/ci.yml`**

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  build-test:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
        node: [20, 22]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: npm
      - run: npm ci
      - run: npm run build
      - run: npm test

  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm run format:check
```
<!-- ponytail: lint runs once on ubuntu (style is OS-independent); build+test fan out to prove native/ONNX deps install on all 3 OSes. -->

- [ ] **Step 2: Locally simulate the CI job commands**

Run:
```bash
rm -rf node_modules && npm ci && npm run build && npm test && npm run lint && npm run format:check
```
Expected: every command exits 0. This mirrors exactly what CI runs; if it's green locally on a clean install, CI will be green on ubuntu/macos. (Windows native-dep install can differ — flagged in Step 4.)

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add build/test matrix (Node 20/22 x ubuntu/macos/windows) + lint job

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Push and open the PR; watch the first CI run**

```bash
git push -u origin feature/p0-guardrails
gh pr create --fill --title "P0: enterprise-readiness guardrails" \
  --body "Implements P0 of docs/superpowers/specs/2026-07-02-enterprise-readiness-roadmap-design.md: zod v4 unification, ESLint+Prettier, repo hygiene, .env.example drift fix, CI matrix."
gh pr checks --watch
```
Expected: all matrix legs green. **Known risk:** `better-sqlite3` / `@huggingface/transformers` (ONNX) native builds on `windows-latest` may fail or need a prebuilt binary / build-tools step. If Windows fails on native install, the fix is either (a) add a Windows build-tools setup step, or (b) if the app is never run on Windows CI, drop `windows-latest` from the matrix and note it in the PR. Do NOT mark P0 done with a red required check — resolve or explicitly de-scope with the owner.

---

## Self-Review

**Spec coverage (§4 P0):**
- CI (build+test, Node 20/22 × 3 OS) → Task 5. ✓
- ESLint + Prettier + editorconfig → Task 2. ✓
- Resolve zod split (upgrade core+mcp to v4) → Task 1. ✓
- `.nvmrc`, root `tsconfig.json`, LICENSE, SECURITY.md, `.gitignore .superpowers/` → Task 3. ✓
- Regenerate `.env.example` (5 missing vars) → Task 4. ✓
- Acceptance (green CI 3 OSes, `npm run lint` clean, single zod major, `.env.example` matches schema) → covered by Tasks 1/2/4/5 verification steps. ✓

**Placeholder scan:** No "TBD"/"handle edge cases"/"write tests for the above" — every code/config step shows the actual content. The zod-migration discovery step (Task 1 Step 3) enumerates the concrete v4 API mappings that apply to this code rather than saying "fix errors." ✓

**Type consistency:** `loadConfig`/`AppConfig` unchanged (Task 1); scripts named consistently (`lint`, `format:check`, `typecheck`) across Tasks 2/3/5; branch name `feature/p0-guardrails` consistent Task 0/5. ✓

**Note:** LICENSE text (Task 3 Step 6) is a default proprietary notice — confirm the intended license with the owner before merge; it does not block any other task.
