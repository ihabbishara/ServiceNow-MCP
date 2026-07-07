# Proactive Code-Analysis Engagement — Design

**Date:** 2026-07-07
**Status:** Approved

## Problem

The Code Analyser only runs when the user explicitly asks for a root cause.
The steering instruction is reactive ("when … the user wants a root cause"),
so incidents full of stack traces come and go without the agent ever offering
its strongest capability. The user wants **structural engagement**: the agent
should notice code-referencing errors, proactively offer a codebase
root-cause analysis, and ask for the repo URL when the user accepts.

## Decision (user-confirmed)

- Trigger scope: **any incident fetch** — both `get_incident` and
  `summarize_incident` carry the structural hint.
- Detection is deterministic code (regex detector), not model attention —
  the hint lands in tool results, which the model reliably reads, on every
  surface (MCP hosts included).
- Consent stays with the user: the agent OFFERS analysis and asks for the
  repo URL; it never auto-runs.

## Architecture

### 1. Detector — `packages/core/src/services/codeSignals.ts`

Pure function, no I/O:

```ts
export interface CodeSignals {
  detected: boolean;
  /** Up to 3 trimmed matched snippets, for the agent to quote when offering. */
  signals: string[];
}
export const detectCodeSignals = (texts: (string | undefined)[]): CodeSignals
```

Scans the joined text for, in priority order:

1. **Stack frames / file:line references with a known code extension** —
   `at fn (file.ext:line)` and bare `path/file.ext:line`, where `ext` is in
   an allowlist (`ts, tsx, js, jsx, mjs, cjs, java, py, cs, go, rb, php, kt,
   kts, scala, swift, cpp, cc, c, h, hpp, rs, sql`). The extension allowlist
   is what kills false positives: `10.0.0.1:443` (IP:port) and `v1.2.3`
   (semver) have no code extension and never match.
2. **Exception/error class names** — `\b[A-Z]\w*(Exception|Error)\b\s*[:(]`
   (e.g. `NullPointerException:`, `TypeError:`).
3. **Python tracebacks** — the literal `Traceback (most recent call last)`.

`signals` collects up to 3 distinct matches (each trimmed, single-line,
≤120 chars). `detected` is true if any pattern matched.

### 2. Structural hint — `packages/core/src/tools/specs/incidents.ts`

Both `get_incident` and `summarize_incident` append a `codeAnalysis` block to
their result **only when** the ADO org is configured
(`rt.config.azureDevOps.orgUrl`) **and** the detector fires on the incident's
text fields (`shortDescription`, `description`, `workNotes`, `comments`).
Otherwise the block is omitted entirely — zero noise on clean incidents or
unconfigured installs.

```jsonc
"codeAnalysis": {
  "signalsDetected": true,
  "signals": ["TypeError: Cannot read properties of undefined (charge.ts:42)"],
  "nextStep": "Code-referencing errors detected in this incident. Proactively ask the user whether they want a codebase root-cause analysis. If they accept, ask for the Azure DevOps repo clone URL (https://dev.azure.com/<org>/<project>/_git/<repo>) and optionally the deployed branch/tag, then run analyze_code with the incident's error text — or use checkout_repo/search_repo/read_repo_file directly if analyze_code is not available on this surface."
}
```

- `get_incident` currently returns the raw incident object; it becomes
  `{ ...incident, codeAnalysis? }`.
- `summarize_incident` adds `codeAnalysis` as a top-level key beside
  `incident`/`relatedChanges`.
- The `nextStep` wording is surface-neutral: sre-agent has `analyze_code`;
  MCP hosts fall back to the raw repo tools they do have.

### 3. Prompt reinforcement

- **`incident_triage` prompt** (`packages/core/src/prompts/registry.ts`):
  the "Root Cause Hypothesis" section gains a line:
  "If the incident contains stack traces or code-referencing errors (see
  `codeAnalysis` in the summary), offer a codebase root-cause analysis and
  ask for the repo clone URL."
- **`CODE_ANALYSIS_SYSTEM_INSTRUCTION`**
  (`packages/sre-agent/src/engine/engine.ts`): reworded from reactive to
  proactive — when an incident contains stack traces / code-referencing
  errors, or a tool result carries `codeAnalysis.signalsDetected`,
  **proactively offer** the analysis (quote a detected signal), ask for the
  repo clone URL in the stated format, then call `analyze_code` after the
  user provides it. Never run without the user's go-ahead.

### 4. Data flow

```
user: look at INC0012345
agent: get_incident → result carries codeAnalysis { signals, nextStep }
agent: "This incident references code (TypeError at charge.ts:42).
        Want me to analyse the codebase for the root cause?
        If yes: repo URL, format https://dev.azure.com/<org>/<project>/_git/<repo>"
user:  yes — <url>
agent: analyze_code(...) → 🔬 timeline → report
```

## Error handling

- Detector is pure; malformed/undefined fields are skipped (`filter(Boolean)`
  before join). No throw path.
- Hint construction failure is impossible by design (static strings + array
  slice); no change to tool error contracts.

## Testing

- **Detector** (`packages/core/tests/services/codeSignals.test.ts`):
  positives — Node stack frame, bare `file.ts:42`, Java exception name,
  Python traceback, mixed text; negatives — plain prose, URLs, IP:port,
  semver versions, timestamps (`12:30:45`), empty/undefined inputs; caps —
  max 3 signals, snippet trimming.
- **Tools** (`packages/core/tests/tools/registry.test.ts` or a focused
  file): hint present when org configured + signals in description/notes;
  absent when ADO unconfigured; absent when text is clean; `get_incident`
  spread preserves original incident fields.
- **Prompts**: `incident_triage` build output contains the new offer line.
- **Engine**: instruction text updated — existing content assertions in
  engine.test.ts adjusted to the new wording (still gated on ADO org).

## Out of scope (deliberate)

- Remembering the repo URL across turns/sessions.
- Auto-running analysis without user consent.
- Signals in `search_incidents` result lists (noise at scale).
- CMDB/business-service → repo suggestions.
