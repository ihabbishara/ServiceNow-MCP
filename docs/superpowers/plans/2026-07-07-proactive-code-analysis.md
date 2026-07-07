# Proactive Code-Analysis Engagement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The agent proactively offers a codebase root-cause analysis whenever a fetched incident contains code-referencing errors, asking the user for consent and the repo URL.

**Architecture:** A pure regex detector (`detectCodeSignals`) in core services; `get_incident` and `summarize_incident` append a `codeAnalysis` hint block to their results when the ADO org is configured and the detector fires; the `incident_triage` prompt and the sre-agent steering instruction are reworded from reactive to proactive. Detection is deterministic tool-result content — structural, model-independent, works on both MCP and sre-agent surfaces.

**Tech Stack:** TypeScript ESM monorepo, vitest, zod tool specs (single-source registry).

**Spec:** `docs/superpowers/specs/2026-07-07-proactive-code-analysis-design.md`

## Global Constraints

- `codeAnalysis` block appears ONLY when `rt.config.azureDevOps.orgUrl` is set AND the detector fires; otherwise the key is omitted entirely (zero noise).
- Detector extension allowlist (verbatim): `ts, tsx, js, jsx, mjs, cjs, java, py, cs, go, rb, php, kt, kts, scala, swift, cpp, cc, c, h, hpp, rs, sql` — this is what excludes IP:port (`10.0.0.1:443`), semver (`v1.2.3`), and timestamps (`12:30:45`).
- Bare `Error:` / `Exception:` (no class-name prefix) must NOT trigger — infra messages like "Error: timeout connecting to db" are not code signals.
- `signals` capped at 3 distinct snippets, each single-line, trimmed, ≤120 chars.
- Consent stays with the user: all wording OFFERS analysis; nothing auto-runs.
- Scanned incident text fields: `shortDescription`, `description`, `workNotes` (string[]), `comments` (string[]).
- The reworded steering instruction must still contain `analyze_code` and `_git/` (existing engine tests assert those).
- Run all commands from repo root `/Users/ihabbishara/projects/ServiceNowMCP`; lint-clean before commit.

---

### Task 1: `detectCodeSignals` detector

**Files:**
- Create: `packages/core/src/services/codeSignals.ts`
- Test: `packages/core/tests/services/codeSignals.test.ts`

**Interfaces:**
- Produces (Task 2 relies on):
  - `export interface CodeSignals { detected: boolean; signals: string[] }`
  - `export const detectCodeSignals = (texts: (string | undefined)[]): CodeSignals`

- [ ] **Step 1: Write the failing tests**

Create `packages/core/tests/services/codeSignals.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { detectCodeSignals } from "../../src/services/codeSignals.js";

describe("detectCodeSignals positives", () => {
  it("detects a Node stack frame", () => {
    const r = detectCodeSignals(["at charge (src/payments/charge.ts:42:11)"]);
    expect(r.detected).toBe(true);
    expect(r.signals[0]).toContain("charge.ts:42");
  });

  it("detects a bare file:line with a code extension", () => {
    const r = detectCodeSignals(["failure in OrderService.java:118 during checkout"]);
    expect(r.detected).toBe(true);
    expect(r.signals[0]).toContain("OrderService.java:118");
  });

  it("detects exception class names", () => {
    expect(detectCodeSignals(["NullPointerException: order was null"]).detected).toBe(true);
    expect(detectCodeSignals(["TypeError: Cannot read properties of undefined"]).detected).toBe(true);
  });

  it("detects a Python traceback", () => {
    expect(detectCodeSignals(["Traceback (most recent call last):", "  File \"app.py\""]).detected).toBe(true);
  });

  it("finds signals across multiple fields (worknotes + description)", () => {
    const r = detectCodeSignals(["users cannot pay", "logs show: at pay (billing.py:9)"]);
    expect(r.detected).toBe(true);
  });
});

describe("detectCodeSignals negatives", () => {
  it("ignores plain prose, URLs, IP:port, semver, timestamps", () => {
    const r = detectCodeSignals([
      "Users report the checkout page is slow since 12:30:45.",
      "Service at https://pay.example.com/v2 returns 502.",
      "Upstream 10.0.0.1:443 unreachable. Deployed v1.2.3 yesterday."
    ]);
    expect(r).toEqual({ detected: false, signals: [] });
  });

  it("ignores bare 'Error:' / 'Exception:' without a class-name prefix", () => {
    expect(detectCodeSignals(["Error: timeout connecting to db"]).detected).toBe(false);
    expect(detectCodeSignals(["Exception: something broke"]).detected).toBe(false);
  });

  it("handles empty and undefined inputs", () => {
    expect(detectCodeSignals([])).toEqual({ detected: false, signals: [] });
    expect(detectCodeSignals([undefined, "", undefined])).toEqual({ detected: false, signals: [] });
  });
});

describe("detectCodeSignals caps", () => {
  it("caps at 3 distinct signals", () => {
    const r = detectCodeSignals(["a.ts:1 b.ts:2 c.ts:3 d.ts:4 e.ts:5"]);
    expect(r.signals).toHaveLength(3);
    expect(r.detected).toBe(true);
  });

  it("dedupes identical snippets and flattens whitespace", () => {
    const r = detectCodeSignals(["at f (x.ts:1)\nat f (x.ts:1)"]);
    expect(r.signals).toHaveLength(1);
    expect(r.signals[0]).not.toContain("\n");
  });

  it("truncates snippets to 120 chars", () => {
    const long = "at " + "x".repeat(150) + " (deep/path/file.ts:12)";
    const r = detectCodeSignals([long]);
    expect(r.signals[0].length).toBeLessThanOrEqual(120);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/core/tests/services/codeSignals.test.ts`
Expected: FAIL — `Cannot find module '../../src/services/codeSignals.js'`

- [ ] **Step 3: Implement `packages/core/src/services/codeSignals.ts`**

```ts
export interface CodeSignals {
  detected: boolean;
  /** Up to 3 trimmed matched snippets, for the agent to quote when offering analysis. */
  signals: string[];
}

// Known source-code extensions. The allowlist is what excludes IP:port
// (10.0.0.1:443), semver (v1.2.3), and timestamps (12:30:45) from matching.
const CODE_EXTENSIONS =
  "ts|tsx|js|jsx|mjs|cjs|java|py|cs|go|rb|php|kt|kts|scala|swift|cpp|cc|c|h|hpp|rs|sql";

const PATTERNS: RegExp[] = [
  // Stack frame: at fn (path/file.ext:line[:col])
  new RegExp(
    `\\bat\\s+[\\w$.<>\\[\\]]+\\s*\\([^()]*\\.(?:${CODE_EXTENSIONS}):\\d+(?::\\d+)?\\)`,
    "g"
  ),
  // Bare file:line with a code extension
  new RegExp(`\\b[\\w./\\\\-]+\\.(?:${CODE_EXTENSIONS}):\\d+\\b`, "g"),
  // Exception/error class names followed by ':' or '(' — bare Error:/Exception: filtered below
  /\b[A-Za-z]\w*(?:Exception|Error)\b\s*[:(]/g,
  /Traceback \(most recent call last\)/g
];

// "Error: timeout" is an infra message, not a code signal — require a class-name prefix.
const BARE_ERROR = /^(?:Error|Exception)\s*[:(]/;

/**
 * Deterministic detector for code-referencing error text (stack traces,
 * file:line references, exception class names). Pure function, no I/O;
 * undefined fields are skipped.
 */
export const detectCodeSignals = (texts: (string | undefined)[]): CodeSignals => {
  const text = texts.filter(Boolean).join("\n");
  const signals: string[] = [];
  for (const pattern of PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      if (BARE_ERROR.test(match[0])) continue;
      const snippet = match[0].replace(/\s+/g, " ").trim().slice(0, 120);
      if (!signals.includes(snippet)) signals.push(snippet);
      if (signals.length >= 3) return { detected: true, signals };
    }
  }
  return { detected: signals.length > 0, signals };
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/core/tests/services/codeSignals.test.ts`
Expected: PASS (all three describes)

- [ ] **Step 5: Lint and commit**

```bash
npx eslint packages/core/src/services/codeSignals.ts packages/core/tests/services/codeSignals.test.ts
git add packages/core/src/services/codeSignals.ts packages/core/tests/services/codeSignals.test.ts
git commit -m "feat(core): detectCodeSignals — deterministic code-error detector"
```

---

### Task 2: `codeAnalysis` hint in `get_incident` / `summarize_incident`

**Files:**
- Modify: `packages/core/src/tools/specs/incidents.ts` (get_incident run ~line 71, summarize_incident run ~line 85)
- Test: `packages/core/tests/tools/codeAnalysisHint.test.ts` (new)

**Interfaces:**
- Consumes: `detectCodeSignals(texts): { detected, signals }` (Task 1); `Incident` type has `shortDescription`, `description?`, `workNotes?: string[]`, `comments?: string[]` (packages/core/src/types.ts).
- Produces: tool results optionally carrying
  `codeAnalysis: { signalsDetected: true; signals: string[]; nextStep: string }` — Task 3's prompt text references this key name; keep it exact.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/tests/tools/codeAnalysisHint.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { TOOL_SPECS } from "../../src/tools/registry.js";
import type { McpRuntime } from "../../src/runtime.js";

const spec = (n: string) => TOOL_SPECS.find((s) => s.name === n)!;

const INCIDENT = {
  number: "INC0012345",
  priority: "1",
  state: "In Progress",
  shortDescription: "Checkout failing",
  description: "TypeError: Cannot read properties of undefined at charge (charge.ts:42:11)",
  assignedTo: "Jane",
  assignmentGroup: "Payments",
  businessService: "Checkout",
  cmdbCi: "pay-svc",
  openedAt: "2026-07-07T08:00:00Z",
  updatedAt: "2026-07-07T09:00:00Z",
  slaDue: null,
  workNotes: ["restarted pod, no effect"],
  comments: []
};

const makeRuntime = (orgUrl?: string, incident: object = INCIDENT) =>
  ({
    config: { azureDevOps: { orgUrl } },
    serviceNowClient: { getIncidentByNumber: vi.fn(async () => incident) },
    incidentService: {
      summarizeIncident: vi.fn(async () => ({
        incident: INCIDENT,
        relatedChanges: [],
        linkedWorkItems: []
      }))
    }
  }) as unknown as McpRuntime;

describe("codeAnalysis hint", () => {
  it("get_incident appends the hint when ADO configured and signals present", async () => {
    const res = (await spec("get_incident").run(makeRuntime("https://dev.azure.com/Org"), {
      number: "INC0012345"
    })) as Record<string, unknown>;
    const hint = res.codeAnalysis as { signalsDetected: boolean; signals: string[]; nextStep: string };
    expect(hint.signalsDetected).toBe(true);
    expect(hint.signals[0]).toContain("charge.ts:42");
    expect(hint.nextStep).toContain("ask the user");
    expect(hint.nextStep).toContain("_git/");
    expect(res.number).toBe("INC0012345"); // original fields preserved
  });

  it("summarize_incident appends the hint at top level", async () => {
    const res = (await spec("summarize_incident").run(makeRuntime("https://dev.azure.com/Org"), {
      number: "INC0012345"
    })) as Record<string, unknown>;
    expect(res.codeAnalysis).toMatchObject({ signalsDetected: true });
    expect(res.incident).toBeDefined();
  });

  it("omits the hint when ADO is not configured", async () => {
    const res = (await spec("get_incident").run(makeRuntime(undefined), {
      number: "INC0012345"
    })) as Record<string, unknown>;
    expect("codeAnalysis" in res).toBe(false);
  });

  it("omits the hint when the incident text is clean", async () => {
    const clean = { ...INCIDENT, description: "users report slowness", workNotes: [] };
    const rt = makeRuntime("https://dev.azure.com/Org", clean);
    (rt.incidentService.summarizeIncident as ReturnType<typeof vi.fn>).mockResolvedValue({
      incident: clean,
      relatedChanges: [],
      linkedWorkItems: []
    });
    const got = (await spec("get_incident").run(rt, { number: "INC0012345" })) as Record<string, unknown>;
    expect("codeAnalysis" in got).toBe(false);
    const sum = (await spec("summarize_incident").run(rt, { number: "INC0012345" })) as Record<string, unknown>;
    expect("codeAnalysis" in sum).toBe(false);
  });

  it("scans workNotes and comments, not just description", async () => {
    const noteOnly = {
      ...INCIDENT,
      description: "see notes",
      workNotes: ["stack: at pay (billing.py:9)"]
    };
    const res = (await spec("get_incident").run(makeRuntime("https://dev.azure.com/Org", noteOnly), {
      number: "INC0012345"
    })) as Record<string, unknown>;
    expect(res.codeAnalysis).toMatchObject({ signalsDetected: true });
  });
});
```

If the existing summarize path requires more of the service result shape (check the spec's mapping of `relatedChanges`/`linkedWorkItems` fields when the test fails on undefined), extend the fake's resolved object minimally to satisfy it.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/core/tests/tools/codeAnalysisHint.test.ts`
Expected: FAIL — `codeAnalysis` undefined on both tools.

- [ ] **Step 3: Implement in `packages/core/src/tools/specs/incidents.ts`**

Add imports and the helper at the top of the file:

```ts
import { detectCodeSignals } from "../../services/codeSignals.js";
import type { McpRuntime } from "../../runtime.js";
```

```ts
// Surface-neutral: sre-agent has analyze_code; MCP hosts fall back to the raw repo tools.
const CODE_ANALYSIS_NEXT_STEP =
  "Code-referencing errors detected in this incident. Proactively ask the user whether they want a " +
  "codebase root-cause analysis. If they accept, ask for the Azure DevOps repo clone URL " +
  "(https://dev.azure.com/<org>/<project>/_git/<repo>) and optionally the deployed branch/tag, then " +
  "run analyze_code with the incident's error text — or use checkout_repo/search_repo/read_repo_file " +
  "directly if analyze_code is not available on this surface.";

interface IncidentTexts {
  shortDescription?: string;
  description?: string;
  workNotes?: string[];
  comments?: string[];
}

/** Structural engagement hint: {} unless ADO is configured AND the incident text carries code signals. */
const codeAnalysisHint = (
  rt: McpRuntime,
  inc: IncidentTexts
): { codeAnalysis?: { signalsDetected: true; signals: string[]; nextStep: string } } => {
  if (!rt.config.azureDevOps.orgUrl) return {};
  const { detected, signals } = detectCodeSignals([
    inc.shortDescription,
    inc.description,
    ...(inc.workNotes ?? []),
    ...(inc.comments ?? [])
  ]);
  if (!detected) return {};
  return { codeAnalysis: { signalsDetected: true, signals, nextStep: CODE_ANALYSIS_NEXT_STEP } };
};
```

In `get_incident`'s `run`, replace `return incident;` with:

```ts
      return { ...incident, ...codeAnalysisHint(rt, incident) };
```

In `summarize_incident`'s `run`, add the spread to the returned object literal (top level, after the existing keys):

```ts
        ...codeAnalysisHint(rt, result.incident)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/core/tests/tools/codeAnalysisHint.test.ts packages/core/tests/tools/registry.test.ts`
Expected: PASS — new hint tests plus existing incident-tool assertions untouched.

- [ ] **Step 5: Lint and commit**

```bash
npx eslint packages/core/src/tools/specs/incidents.ts packages/core/tests/tools/codeAnalysisHint.test.ts
git add packages/core/src/tools/specs/incidents.ts packages/core/tests/tools/codeAnalysisHint.test.ts
git commit -m "feat(core): structural codeAnalysis hint on incident tools"
```

---

### Task 3: Prompt + steering reinforcement

**Files:**
- Modify: `packages/core/src/prompts/registry.ts` (incident_triage build, Root Cause Hypothesis section ~line 38)
- Modify: `packages/sre-agent/src/engine/engine.ts` (CODE_ANALYSIS_SYSTEM_INSTRUCTION ~line 35)
- Test: `packages/core/tests/prompts/registry.test.ts`, `packages/sre-agent/tests/engine.test.ts`

**Interfaces:**
- Consumes: `codeAnalysis` result key name (Task 2 — referenced in prompt copy).
- Produces: no new interfaces; wording changes only.

- [ ] **Step 1: Write the failing tests**

In `packages/core/tests/prompts/registry.test.ts`, inside the existing incident_triage test (or a new `it` in that describe):

```ts
  it("triage prompt offers proactive code analysis on code signals", () => {
    const text = promptSpec("incident_triage").build({ incident_number: "INC0012345" });
    expect(text).toContain("codeAnalysis");
    expect(text).toContain("codebase root-cause analysis");
    expect(text).toContain("repo clone URL");
  });
```

In `packages/sre-agent/tests/engine.test.ts`, in the `CODE_ANALYSIS_SYSTEM_INSTRUCTION` describe, extend the "is appended when ADO org is configured" test (or add one) with:

```ts
    expect(sc.systemMessage?.content).toContain("signalsDetected");
    expect(sc.systemMessage?.content).toContain("Never run the analysis without");
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/core/tests/prompts/registry.test.ts packages/sre-agent/tests/engine.test.ts`
Expected: the two new assertions FAIL; everything else PASSES.

- [ ] **Step 3: Implement**

1. `packages/core/src/prompts/registry.ts` — in the incident_triage `build` template, extend the Root Cause Hypothesis section:

```
2. **Root Cause Hypothesis**
   - Review related changes - could any have caused this?
   - Check for patterns in recent similar incidents
   - Identify most likely cause
   - If the incident contains stack traces or code-referencing errors (see \`codeAnalysis\` in the summary), offer a codebase root-cause analysis and ask for the repo clone URL
```

(Use a backtick-escaped `codeAnalysis` inside the template literal exactly as shown.)

2. `packages/sre-agent/src/engine/engine.ts` — replace the constant:

```ts
/** Appended when ADO is configured: steer toward proactively offering analyze_code. */
export const CODE_ANALYSIS_SYSTEM_INSTRUCTION =
  "This agent has an `analyze_code` tool that checks out an Azure DevOps git repository and pinpoints " +
  "likely root-cause code locations for an incident's error output. Be proactive: when an incident " +
  "contains stack traces or error messages referencing application code — or a tool result carries a " +
  "`codeAnalysis.signalsDetected` hint — offer the user a codebase root-cause analysis, quoting one " +
  "detected signal. If they accept, ask for the repo clone URL in the format " +
  "https://dev.azure.com/<org>/<project>/_git/<repo> (and optionally the deployed branch/tag), then " +
  "call `analyze_code` with that URL and the error text. Never run the analysis without the user's " +
  "go-ahead. Relay the analyser's report and cite the suspect file:line locations.";
```

(Keeps `analyze_code` and `_git/` — the existing assertions stay green.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/core/tests/prompts/registry.test.ts packages/sre-agent/tests/engine.test.ts`
Expected: PASS.

- [ ] **Step 5: Lint and commit**

```bash
npx eslint packages/core/src/prompts/registry.ts packages/sre-agent/src/engine/engine.ts
git add packages/core/src/prompts/registry.ts packages/sre-agent/src/engine/engine.ts packages/core/tests/prompts/registry.test.ts packages/sre-agent/tests/engine.test.ts
git commit -m "feat: proactive code-analysis offer in triage prompt and steering instruction"
```

---

### Task 4: Full verification

**Files:** none new — whole-workspace gates.

- [ ] **Step 1: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: clean exit.

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: all packages green.

- [ ] **Step 3: Lint + format**

Run: `npm run lint && npm run format:check`
Expected: lint 0 errors (pre-existing warnings tolerated). If format:check fails on changed files, `npm run format`, re-run all gates.

- [ ] **Step 4: Commit fixups only if any exist**

```bash
git add -A
git commit -m "chore: verification fixups for proactive code analysis"
```
