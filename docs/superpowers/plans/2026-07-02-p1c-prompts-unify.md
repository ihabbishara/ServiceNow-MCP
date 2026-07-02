# P1c — Prompts Unify Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Define the four workflow prompts (incident_triage, shift_handover, change_review, incident_postmortem) exactly once in a core `PROMPT_SPECS` registry, consumed by both the MCP prompt surface and the sre-agent slash-command workflows.

**Architecture:** Mirrors the P1b tool registry: `core/src/prompts/registry.ts` holds a `PromptSpec` type (name, description, raw zod schema shape, `build(args) → string`) and the `PROMPT_SPECS` table with the unified prompt bodies. `mcp-server/src/prompts/index.ts` becomes a thin loop that registers each spec via `server.prompt(...)` wrapping `build` output in the messages envelope. `sre-agent/src/workflows/index.ts` keeps only its slash-command parsing and calls the same `build` functions.

**Tech Stack:** TypeScript strict ESM, zod v4, `@modelcontextprotocol/sdk` ^1.12, vitest 2.

## Global Constraints

- One branch `feature/p1c-prompts-unify`, one squash-PR. Commit after every task.
- **Before EVERY commit run: `npm run build && npm test && npm run lint && npm run format:check`.** CI gates on Prettier.
- `@sre/core` must NOT gain a dependency on `@github/copilot-sdk` or `@modelcontextprotocol/sdk`.
- The unified prompt bodies are the CURRENT sre-agent versions (`packages/sre-agent/src/workflows/index.ts`), verbatim — they are the richer superset (knowledge/SharePoint call-outs) and reference tools that exist on both surfaces since P1b. Agent output stays **byte-identical**; `packages/sre-agent/tests/workflows.test.ts` must pass UNCHANGED.
- `buildWorkflowPrompt` export name and signature `(line: string) => string | null` unchanged — consumed by `sre-agent/src/cli/index.ts:255`, `web/server/engine-host.ts:207`, and `sre-agent/src/index.ts` re-export (pinned by `tests/exports.test.ts`).
- `registerPrompts(server, _runtime)` signature unchanged — `mcp-server/src/server.ts:29` calls it; server.ts is NOT touched this phase.
- zod v4 idioms; ESM `.js` import extensions; `schema` is a raw zod shape (`z.ZodRawShape`), not `z.object(...)` — `server.prompt` registers raw shapes.
- Run tests with `npx vitest run <path>`; full suite `npm test` (495 green at base `e971253`).

## Intentional behavior deltas (the ONLY allowed changes)

1. **MCP prompt texts gain the agent's richer paragraphs** (drift reconciliation — richer variant wins, same rule as P1b delta #7):
   - `incident_triage`: + search_knowledge paragraph, + get_incident_documents paragraph
   - `shift_handover`: tool list gains item `5. search_knowledge - find runbooks relevant to the active incidents the next shift may need`
   - `change_review`: + search_knowledge (change/deployment standards) paragraph
   - `incident_postmortem`: + search_knowledge (runbook check) paragraph, + get_incident_documents paragraph
2. Everything else — prompt names, descriptions, MCP argument schemas (`z.coerce.number().int().positive().optional()` for hours_back), the messages envelope, and ALL agent-side output — stays byte-identical.

## File map (end state)

| File | Responsibility |
|---|---|
| `packages/core/src/prompts/registry.ts` | `PromptSpec`, `definePromptSpec`, `PROMPT_SPECS` (4 specs, unified bodies) |
| `packages/core/tests/prompts/registry.test.ts` | registry structure + build-output tests |
| `packages/mcp-server/src/prompts/index.ts` | thin adapter: loop `PROMPT_SPECS` → `server.prompt(...)` (rewritten, 231 → ~30 lines) |
| `packages/mcp-server/tests/prompts.test.ts` | NEW — parity (registrations === PROMPT_SPECS) + envelope test via InMemoryTransport |
| `packages/sre-agent/src/workflows/index.ts` | slash-command parsing only; templates deleted (179 → ~45 lines) |

---

### Task 1: Core prompt registry + MCP adapter

**Files:**
- Create: `packages/core/src/prompts/registry.ts`
- Create: `packages/core/tests/prompts/registry.test.ts`
- Modify: `packages/core/src/index.ts` (add one export line)
- Rewrite: `packages/mcp-server/src/prompts/index.ts`
- Create: `packages/mcp-server/tests/prompts.test.ts`

**Interfaces:**
- Consumes: nothing new (zod only).
- Produces (Task 2 relies on these exact names):
  - `interface PromptSpec<Shape extends z.ZodRawShape = z.ZodRawShape> { name: string; description: string; schema: Shape; build(args: z.infer<z.ZodObject<Shape>>): string; }`
  - `definePromptSpec<S extends z.ZodRawShape>(spec: PromptSpec<S>): PromptSpec`
  - `PROMPT_SPECS: PromptSpec[]` — order: incident_triage, shift_handover, change_review, incident_postmortem
  - `promptSpec(name: string): PromptSpec` — lookup helper that throws on unknown name
  - All exported from `@sre/core`.

- [ ] **Step 1: Write the failing core registry test**

Create `packages/core/tests/prompts/registry.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { PROMPT_SPECS, promptSpec } from "../../src/prompts/registry.js";

describe("PROMPT_SPECS registry", () => {
  it("holds exactly the four prompts with unique names and metadata", () => {
    expect(PROMPT_SPECS.map((p) => p.name)).toEqual([
      "incident_triage",
      "shift_handover",
      "change_review",
      "incident_postmortem"
    ]);
    for (const p of PROMPT_SPECS) {
      expect(p.description.length).toBeGreaterThan(10);
      expect(typeof p.schema).toBe("object");
      expect(typeof p.build).toBe("function");
    }
  });

  it("promptSpec throws on unknown name", () => {
    expect(() => promptSpec("nope")).toThrow(/unknown prompt/i);
  });

  it("incident_triage interpolates the incident and keeps the knowledge/SharePoint guidance", () => {
    const text = promptSpec("incident_triage").build({ incident_number: "INC0012345" });
    expect(text).toContain("Help me triage incident INC0012345.");
    expect(text).toContain("summarize_incident");
    expect(text).toContain("search_knowledge");
    expect(text).toContain("get_incident_documents for INC0012345");
    expect(text).toContain("Be concise and actionable. Focus on what to do now.");
  });

  it("shift_handover interpolates team + hours and defaults hours to 8", () => {
    const withHours = promptSpec("shift_handover").build({ team_name: "Platform SRE", hours_back: 12 });
    expect(withHours).toContain("for the Platform SRE team, covering the last 12 hours.");
    const defaulted = promptSpec("shift_handover").build({ team_name: "Platform SRE" });
    expect(defaulted).toContain("covering the last 8 hours.");
    expect(defaulted).toContain("5. search_knowledge");
  });

  it("change_review interpolates the change number and steers to search_knowledge", () => {
    const text = promptSpec("change_review").build({ change_number: "CHG0005432" });
    expect(text).toContain("Review change CHG0005432 for potential risks and issues.");
    expect(text).toContain("get_change");
    expect(text).toContain("search_knowledge");
  });

  it("incident_postmortem interpolates the incident and keeps runbook + SharePoint guidance", () => {
    const text = promptSpec("incident_postmortem").build({ incident_number: "INC0012345" });
    expect(text).toContain("Help me structure a postmortem for incident INC0012345.");
    expect(text).toContain("search_knowledge");
    expect(text).toContain("get_incident_documents for INC0012345");
    expect(text).toContain("Focus on learning and prevention, not blame.");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run packages/core/tests/prompts/registry.test.ts`
Expected: FAIL — `Cannot find module '../../src/prompts/registry.js'`

- [ ] **Step 3: Implement the registry**

Create `packages/core/src/prompts/registry.ts`. The four bodies are copied VERBATIM from `packages/sre-agent/src/workflows/index.ts` (the richer, unified versions); names/descriptions/schemas from `packages/mcp-server/src/prompts/index.ts`:

```ts
import { z } from "zod";

export interface PromptSpec<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  /** Raw zod shape: MCP registers it directly via server.prompt. */
  schema: Shape;
  build(args: z.infer<z.ZodObject<Shape>>): string;
}

/** Identity helper: full arg-type inference inside the spec, widened for the table. */
export const definePromptSpec = <S extends z.ZodRawShape>(spec: PromptSpec<S>): PromptSpec =>
  spec as PromptSpec;

/** The four workflow prompts, defined once for both surfaces (MCP prompts + agent slash commands). */
export const PROMPT_SPECS: PromptSpec[] = [
  definePromptSpec({
    name: "incident_triage",
    description: "Guide through systematic incident triage process",
    schema: {
      incident_number: z.string().describe("Incident to triage (e.g., INC0012345)")
    },
    build: (a) => `Help me triage incident ${a.incident_number}.

First, use the summarize_incident tool to get full context including related changes.

If internal documentation is indexed, also call search_knowledge to find runbooks or known fixes for these symptoms, and cite the source URLs in your recommendations.

If SharePoint is configured, call get_incident_documents for ${a.incident_number} to pull the incident's supporting documents and incorporate/cite them.

Then guide me through:

1. **Impact Assessment**
   - How many users/services are affected?
   - Is there revenue impact?
   - What's the blast radius?

2. **Root Cause Hypothesis**
   - Review related changes - could any have caused this?
   - Check for patterns in recent similar incidents
   - Identify most likely cause

3. **Immediate Actions**
   - What can be done to mitigate right now?
   - Should we roll back any recent changes?
   - Who needs to be notified?

4. **Next Steps**
   - Assign specific action items
   - Set expected update intervals
   - Identify escalation triggers

Be concise and actionable. Focus on what to do now.`
  }),

  definePromptSpec({
    name: "shift_handover",
    description: "Generate comprehensive shift handover summary",
    schema: {
      team_name: z.string().describe("Team to generate handover for"),
      hours_back: z.coerce
        .number()
        .int()
        .positive()
        .optional()
        .describe("Hours to look back (default: 8)")
    },
    build: (a) => `Generate a shift handover summary for the ${a.team_name} team, covering the last ${a.hours_back ?? 8} hours.

Use these tools to gather information:
1. search_incidents - find all open incidents for the team
2. find_sla_risks - identify any SLA risks
3. find_stale_tickets - find tickets needing updates
4. search_changes - find changes in the time period
5. search_knowledge - find runbooks relevant to the active incidents the next shift may need

Structure the handover as:

## Active Incidents Requiring Attention
- List P1/P2 incidents with current status and next actions

## SLA Risks
- Incidents at risk with time remaining and recommended action

## Tickets Needing Updates
- Stale tickets that need work notes added

## Recent Changes
- Changes deployed in the shift that may be relevant

## Handover Notes
- Key context the next shift needs to know
- Any ongoing investigations
- Scheduled activities coming up

Keep it actionable and prioritized. The incoming shift should know exactly what to focus on first.`
  }),

  definePromptSpec({
    name: "change_review",
    description: "Review a change for potential risks and issues",
    schema: {
      change_number: z.string().describe("Change to review (e.g., CHG0005432)")
    },
    build: (a) => `Review change ${a.change_number} for potential risks and issues.

First, use get_change to get the full change details.

If internal documentation is indexed, call search_knowledge for relevant change or deployment standards and procedures for the affected service.

Then analyze:

1. **Risk Assessment**
   - What's the stated risk level? Is it appropriate?
   - What services/CIs are affected?
   - What's the potential blast radius?

2. **Implementation Plan Review**
   - Is the implementation plan clear and complete?
   - Are there missing steps?
   - Is the timeline realistic?

3. **Backout Plan Review**
   - Is there a backout plan?
   - Is it actionable and tested?
   - What's the expected backout time?

4. **Dependencies & Conflicts**
   - Are there other changes in the same window?
   - Any dependencies on other teams?
   - Potential conflicts with ongoing incidents?

5. **Recommendations**
   - Approve / Request Changes / Reject
   - Specific concerns to address
   - Suggested improvements

Be thorough but concise.`
  }),

  definePromptSpec({
    name: "incident_postmortem",
    description: "Structure a post-incident review discussion",
    schema: {
      incident_number: z.string().describe("Incident for postmortem (e.g., INC0012345)")
    },
    build: (a) => `Help me structure a postmortem for incident ${a.incident_number}.

First, use summarize_incident to get full context including timeline and related changes.

Also call search_knowledge to check for an existing runbook or known issue for this failure, and flag any runbook gaps as action items.

If SharePoint is configured, call get_incident_documents for ${a.incident_number} to pull the incident's documents (timeline notes, comms, analysis) and incorporate them.

Then help me document:

1. **Incident Summary**
   - What happened?
   - When did it start and end?
   - What was the impact (users, revenue, SLA)?

2. **Timeline**
   - Detection time
   - Response time
   - Key milestones
   - Resolution time

3. **Root Cause Analysis**
   - What was the root cause?
   - Were there contributing factors?
   - Was this related to a recent change?

4. **What Went Well**
   - Effective detection
   - Good communication
   - Quick mitigation

5. **What Could Be Improved**
   - Detection gaps
   - Response delays
   - Communication issues

6. **Action Items**
   - Specific, assigned, time-bound actions
   - Preventive measures
   - Detection improvements
   - Runbook updates

Focus on learning and prevention, not blame.`
  })
];

/** Lookup by prompt name; throws on unknown so misuse fails loudly at startup/test time. */
export const promptSpec = (name: string): PromptSpec => {
  const spec = PROMPT_SPECS.find((p) => p.name === name);
  if (!spec) throw new Error(`unknown prompt: ${name}`);
  return spec;
};
```

Add to `packages/core/src/index.ts` (after the tools registry export):

```ts
export * from "./prompts/registry.js";
```

- [ ] **Step 4: Run the core test to verify it passes**

Run: `npx vitest run packages/core/tests/prompts/registry.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing MCP adapter test**

Create `packages/mcp-server/tests/prompts.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { PROMPT_SPECS, promptSpec } from "@sre/core";
import type { McpRuntime } from "@sre/core";
import { registerPrompts } from "../src/prompts/index.js";

describe("registerPrompts parity", () => {
  it("registers every PROMPT_SPECS entry with its exact name, description, and schema", () => {
    const seen: Array<{ name: string; description: string; schema: unknown }> = [];
    const fakeServer = {
      prompt: (name: string, description: string, schema: unknown) => {
        seen.push({ name, description, schema });
      }
    };
    registerPrompts(fakeServer as unknown as McpServer, {} as McpRuntime);
    expect(seen).toEqual(
      PROMPT_SPECS.map((p) => ({ name: p.name, description: p.description, schema: p.schema }))
    );
  });
});

describe("prompt envelope over the wire", () => {
  const connect = async () => {
    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerPrompts(server, {} as McpRuntime);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "c", version: "0.0.0" });
    await Promise.all([server.connect(st), client.connect(ct)]);
    return client;
  };

  it("incident_triage returns one user message whose text is the registry build output", async () => {
    const client = await connect();
    const res = await client.getPrompt({
      name: "incident_triage",
      arguments: { incident_number: "INC0012345" }
    });
    expect(res.messages).toHaveLength(1);
    expect(res.messages[0].role).toBe("user");
    expect(res.messages[0].content).toEqual({
      type: "text",
      text: promptSpec("incident_triage").build({ incident_number: "INC0012345" })
    });
  });

  it("shift_handover coerces hours_back from the string MCP transports it as", async () => {
    const client = await connect();
    const res = await client.getPrompt({
      name: "shift_handover",
      arguments: { team_name: "Platform SRE", hours_back: "12" }
    });
    const text = (res.messages[0].content as { type: "text"; text: string }).text;
    expect(text).toContain("for the Platform SRE team, covering the last 12 hours.");
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npm run build && npx vitest run packages/mcp-server/tests/prompts.test.ts`
Expected: FAIL — the parity test's `seen` array won't match (old `registerPrompts` registers hand-written schemas/texts; the first test compares against `PROMPT_SPECS` identities). Build first so `@sre/core` exposes the new exports.

- [ ] **Step 7: Rewrite the MCP adapter**

Replace the entire content of `packages/mcp-server/src/prompts/index.ts` with:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PROMPT_SPECS } from "@sre/core";
import type { McpRuntime } from "@sre/core";

/**
 * Registers every core PROMPT_SPECS entry as an MCP prompt. The registry owns
 * names, descriptions, argument schemas, and prompt bodies; this adapter only
 * wraps the built text in the single-user-message envelope MCP expects.
 */
export const registerPrompts = (server: McpServer, _runtime: McpRuntime): void => {
  for (const spec of PROMPT_SPECS) {
    server.prompt(spec.name, spec.description, spec.schema, async (args) => ({
      messages: [
        {
          role: "user" as const,
          content: { type: "text" as const, text: spec.build(args as never) }
        }
      ]
    }));
  }
};
```

- [ ] **Step 8: Run the MCP tests to verify they pass**

Run: `npm run build && npx vitest run packages/mcp-server/tests/prompts.test.ts`
Expected: PASS (both parity and envelope tests)

- [ ] **Step 9: Full suite, lint, commit**

Run: `npm run build && npm test && npm run lint && npm run format:check`
Expected: all green. (`sre-agent` is untouched this task — `workflows.test.ts` still passes against its local templates.)

```bash
git add -A
git commit -m "feat(p1c): core prompt registry + MCP adapter; MCP prompts gain knowledge/SharePoint guidance"
```

---

### Task 2: Agent workflows consume the registry

**Files:**
- Rewrite: `packages/sre-agent/src/workflows/index.ts`
- Modify: `packages/sre-agent/tests/workflows.test.ts` (ADD one parity block only — existing tests unchanged)

**Interfaces:**
- Consumes: `promptSpec(name)` from `@sre/core` (Task 1).
- Produces: `buildWorkflowPrompt(line: string): string | null` — name, signature, and OUTPUT byte-identical to today.

- [ ] **Step 1: Write the failing parity test**

Append to `packages/sre-agent/tests/workflows.test.ts` (add the import at the top with the existing imports):

```ts
import { promptSpec } from "@sre/core";

describe("registry parity (agent workflows)", () => {
  it("slash commands emit exactly the registry build output", () => {
    expect(buildWorkflowPrompt("/triage INC1")).toBe(
      promptSpec("incident_triage").build({ incident_number: "INC1" })
    );
    expect(buildWorkflowPrompt("/review CHG1")).toBe(
      promptSpec("change_review").build({ change_number: "CHG1" })
    );
    expect(buildWorkflowPrompt("/postmortem INC1")).toBe(
      promptSpec("incident_postmortem").build({ incident_number: "INC1" })
    );
    expect(buildWorkflowPrompt("/handover Platform SRE 12")).toBe(
      promptSpec("shift_handover").build({ team_name: "Platform SRE", hours_back: 12 })
    );
    expect(buildWorkflowPrompt("/handover Platform SRE")).toBe(
      promptSpec("shift_handover").build({ team_name: "Platform SRE" })
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails or passes trivially**

Run: `npx vitest run packages/sre-agent/tests/workflows.test.ts`
Expected: PASS already — the local templates and the registry bodies are currently identical text. That is fine: this test is the byte-identity lock for Step 3's rewrite. (If it FAILS here, the Task 1 registry bodies deviated from the agent originals — fix the registry, not this test.)

- [ ] **Step 3: Rewrite the workflows module**

Replace the entire content of `packages/sre-agent/src/workflows/index.ts` with:

```ts
import { promptSpec } from "@sre/core";

/**
 * Workflow commands for the REPL.
 *
 * `buildWorkflowPrompt(line)` maps a leading slash command to a seed prompt
 * built from the core PROMPT_SPECS registry — the same specs the MCP server
 * registers as prompts, so the two surfaces cannot drift. Any non-slash line
 * or unknown command returns `null` so the CLI sends the raw line instead.
 */
export const buildWorkflowPrompt = (line: string): string | null => {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  const arg = rest.join(" ");
  switch (cmd) {
    case "/triage":
      return promptSpec("incident_triage").build({ incident_number: arg });
    case "/review":
      return promptSpec("change_review").build({ change_number: arg });
    case "/postmortem":
      return promptSpec("incident_postmortem").build({ incident_number: arg });
    case "/handover": {
      // Team names can contain spaces; a trailing integer (if present) is the
      // hours-back value. Everything before it is the team name. Default 8.
      const m = arg.match(/^(.*?)(?:\s+(\d+))?$/);
      const team = (m?.[1] ?? arg).trim();
      const hours = m?.[2];
      return promptSpec("shift_handover").build({
        team_name: team,
        ...(hours ? { hours_back: Number(hours) } : {})
      });
    }
    default:
      return null;
  }
};
```

- [ ] **Step 4: Run the workflows tests to verify all pass**

Run: `npm run build && npx vitest run packages/sre-agent/tests/workflows.test.ts`
Expected: PASS — every pre-existing test (interpolation, 8-hour default, search_knowledge steering, null cases) plus the new parity block. NONE of the pre-existing assertions may be edited.

- [ ] **Step 5: Full suite, lint, commit**

Run: `npm run build && npm test && npm run lint && npm run format:check`
Expected: all green (495 base + new tests).

```bash
git add -A
git commit -m "feat(p1c): agent workflows consume the core prompt registry; delete duplicated templates"
```

---

## Acceptance checklist (whole branch — verify before the PR)

- [ ] Each prompt body exists exactly once: `grep -rn "Help me triage incident" packages/*/src` hits only `core/src/prompts/registry.ts` (same for the other three bodies).
- [ ] Agent output byte-identical: pre-existing `workflows.test.ts` assertions untouched and green; parity test locks `buildWorkflowPrompt` output === registry build output.
- [ ] MCP surface: parity test locks registrations === `PROMPT_SPECS`; envelope test proves wire format via InMemoryTransport; the four MCP prompt texts now include the knowledge/SharePoint guidance (delta #1).
- [ ] `registerPrompts` and `buildWorkflowPrompt` signatures unchanged; `server.ts`, CLI, web engine-host, and `sre-agent/src/index.ts` untouched.
- [ ] Net LOC: `mcp-server/src/prompts/index.ts` 231 → ~30; `sre-agent/src/workflows/index.ts` 179 → ~45; bodies live once in core.
- [ ] `npm run build && npm test && npm run lint && npm run format:check` green locally; CI 7/7 on the PR.
