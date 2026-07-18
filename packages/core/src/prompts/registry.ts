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

/** The workflow prompts, defined once for both surfaces (MCP prompts + agent slash commands). */
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
   - If the incident contains stack traces or code-referencing errors (see \`codeAnalysis\` in the summary), offer a codebase root-cause analysis and ask for the repo clone URL

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
    build: (
      a
    ) => `Generate a shift handover summary for the ${a.team_name} team, covering the last ${a.hours_back ?? 8} hours.

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
  }),

  definePromptSpec({
    name: "code_analysis",
    description: "Pinpoint likely root-cause code locations for an incident's error output",
    schema: {
      repo_url: z
        .string()
        .describe(
          "Azure DevOps repo clone URL (https://dev.azure.com/<org>/<project>/_git/<repo>)"
        ),
      error_text: z.string().describe("Error messages / stack traces to analyse"),
      incident_number: z.string().optional().describe("Related incident, e.g. INC0012345"),
      ref: z.string().optional().describe("Branch or tag matching the deployed version")
    },
    build: (
      a
    ) => `You are a Code Analyser. Pinpoint where in the codebase the failure below most likely originates.

Repository: ${a.repo_url}${a.ref ? ` (ref: ${a.ref})` : ""}${
      a.incident_number
        ? `\nIncident: ${a.incident_number} — call get_incident for more context if needed.`
        : ""
    }

Error output to analyse:
\`\`\`
${a.error_text}
\`\`\`

Method:
1. Call checkout_repo for the repository${a.ref ? " at the given ref" : ""}.
2. Extract file names, class/function symbols, and line numbers from the error output.
3. Call search_repo for each symbol or distinctive message fragment.
4. Call read_repo_file around the matches to understand the failing code path.
5. Call repo_history on the suspect files — recent changes are prime suspects.

Report exactly these sections:
## Suspects — file:line list, one line each, with why it is suspect
## Hypothesis — the most likely failure mechanism
## Evidence — code and commit facts supporting the hypothesis
## Suggested fix area — where a fix would land (do not write the fix)
## Confidence — high / medium / low, with the main remaining uncertainty

Ground every claim in tool output. Never invent file contents or line numbers.`
  }),

  definePromptSpec({
    name: "incident_rca",
    description: "Full root-cause analysis for an incident: evidence, change correlation, verdict",
    schema: {
      incident_number: z.string().describe("Incident to analyse (e.g., INC0012345)")
    },
    build: (a) => `Perform a full root-cause analysis for incident ${a.incident_number}.

Gather evidence first:
1. summarize_incident for ${a.incident_number} — full context, timeline, related changes.
2. correlate_changes — changes around the incident start are prime suspects.
3. search_knowledge for runbooks or known issues matching the symptoms; cite source URLs.
4. If SharePoint is configured, get_incident_documents for ${a.incident_number}.
5. If the incident contains stack traces or code-referencing errors, offer a codebase analysis, ask for the repo clone URL, then use analyze_code.

Report exactly these sections:

## Incident snapshot
One markdown table: Number | Priority | State | Opened | Assignment group | Short description.

## Change correlation
Candidate changes as a markdown table: Change | Window | Affected CI | Verdict (suspect / cleared / unknown), one line of reasoning each.

## Root-cause hypothesis
Most likely failure mechanism, alternatives considered, and the evidence separating them.

## Remediation
Immediate mitigation, permanent fix, and prevention — one line each, with a suggested owner.

## Confidence
high / medium / low, with the main remaining uncertainty.

Ground every claim in tool output; never invent data.`
  }),

  definePromptSpec({
    name: "release_readiness",
    description:
      "Go/No-Go assessment of upcoming changes: conflicts, backout plans, incident exposure",
    schema: {
      days_ahead: z.coerce
        .number()
        .int()
        .positive()
        .optional()
        .describe("Days to look ahead (default: 7)")
    },
    build: (a) => `Assess release readiness for the next ${a.days_ahead ?? 7} days.

Gather:
1. search_changes for changes scheduled in the next ${a.days_ahead ?? 7} days.
2. get_change on each candidate for risk level and backout plan detail.
3. search_incidents (only_open) for open incidents on the affected services/CIs.
4. If internal documentation is indexed, search_knowledge for deployment standards on the affected services.

Report exactly these sections:

## Change calendar
Markdown table: Change | Planned window | Affected CI/service | Risk | Backout plan (yes / no / untested).

## Conflicts
Overlapping windows or same-CI collisions as a markdown table: Changes | CI | Overlap | Severity.

## Open-incident exposure
Open P1/P2 incidents on services with pending changes: markdown table Incident | Priority | Service | Related change.

## Go / No-Go
One row per change: Go, Go-with-conditions, or No-Go, with one line of reasoning — as a markdown table.

Be decisive. A missing or untested backout plan is always flagged, never assumed fine.`
  }),

  definePromptSpec({
    name: "ops_report",
    description:
      "Management-facing operations report: volumes, SLA status, trends, recommendations",
    schema: {
      days_back: z.coerce
        .number()
        .int()
        .positive()
        .optional()
        .describe("Days to look back (default: 7)")
    },
    build: (
      a
    ) => `Produce an operations report for management covering the last ${a.days_back ?? 7} days.

Gather:
1. generate_ops_summary for the period baseline.
2. search_incidents for the period's incidents — use the priority and state counts.
3. find_sla_risks for current SLA risks and breaches.
4. search_changes for changes executed in the period.

Report exactly these sections:

## Executive summary
One short paragraph: overall health, the single most important number, the single biggest risk.

## Incident volume
Markdown table: Priority | Opened | Resolved | Still open.

## SLA status
Markdown table: Incident | Time remaining or breached | Owner | Action.

## Top offender services
Markdown table: Service/CI | Incidents | Trend note.

## Change activity
Markdown table: Total changes | Emergency | Failed or backed out.

## Recommendations
At most 3 bullets, each actionable with a suggested owner.

The audience is management: lead with numbers, no jargon, no tool names in the output.`
  }),

  definePromptSpec({
    name: "queue_hygiene",
    description:
      "Queue cleanup review for an assignment group: unassigned, stale, misprioritized, SLA risk",
    schema: {
      group_name: z.string().describe("Assignment group to review (partial name OK, e.g. 'GIOM')")
    },
    build: (a) => `Run a queue-hygiene review for the ${a.group_name} assignment group.

Gather:
1. lookup_assignment_groups for '${a.group_name}' to resolve the exact group name(s).
2. search_incidents (only_open) for the group's open incidents.
3. find_stale_tickets for tickets missing recent updates.
4. find_sla_risks for the group's at-risk items.

Report exactly these sections:

## Unassigned
Open incidents with no assignee: markdown table Number | Priority | State | Opened | Short description.

## Stale
Tickets without recent work notes: markdown table Number | Priority | Last update | Age.

## Misprioritized
P1/P2 sitting in New, or long-open P1s: markdown table Number | Priority | State | Age | Why flagged.

## SLA risk
Markdown table: Number | Time remaining | Recommended action.

## Cleanup actions
Numbered list of concrete actions (assign, update, reprioritize, chase resolution), most urgent first.
There are no ServiceNow write tools — every action is a recommendation for the operator to apply in ServiceNow.

Keep it short and directive; the goal is an empty list next run.`
  }),

  definePromptSpec({
    name: "recurring_incidents",
    description: "Cluster repeat incidents into problem-record candidates with permanent fixes",
    schema: {
      subject: z.string().describe("Assignment group, service, or CI to analyse (e.g. 'GIOM')"),
      days_back: z.coerce
        .number()
        .int()
        .positive()
        .optional()
        .describe("Days to look back (default: 30)")
    },
    build: (
      a
    ) => `Find recurring incidents for ${a.subject} over the last ${a.days_back ?? 30} days.

Gather:
1. search_incidents for ${a.subject} across the period — all states, not just open.
2. Group the results by symptom: similar short descriptions, same CI, same category.
3. search_knowledge for runbooks or known issues covering the biggest clusters.

Report exactly these sections:

## Clusters
Markdown table: Cluster | Count | Example incidents | Common symptom. Only clusters with 2+ incidents.

## Problem-record candidates
Markdown table: Cluster | Why it deserves a problem record | Suggested permanent fix.

## Runbook coverage
Markdown table: Cluster | Runbook exists (yes/no + link) | Gap.

## Recommendations
Up to 3 bullets: highest-leverage permanent fixes first, each with a suggested owner.

A cluster seen 3+ times without a problem record or runbook is always flagged.`
  }),

  definePromptSpec({
    name: "service_health",
    description: "Service scorecard: incident trend, top categories, change activity, verdict",
    schema: {
      service: z.string().describe("Service or CI name (e.g. 'payments-api')"),
      days_back: z.coerce
        .number()
        .int()
        .positive()
        .optional()
        .describe("Days to look back (default: 30)")
    },
    build: (a) => `Assess the health of ${a.service} over the last ${a.days_back ?? 30} days.

Gather:
1. search_incidents for ${a.service} in the period — use priority and state counts.
2. search_changes for changes touching ${a.service} in the period.
3. find_sla_risks for current exposure on the service.

Report exactly these sections:

## Scorecard
One-row markdown table: Incidents opened | Resolved | Still open | P1/P2 count | SLA breaches | Changes executed.

## Incident trend
Markdown table by week: Week | Opened | Resolved | Notable spike cause.

## Top categories
Markdown table: Category/symptom | Count | Example incident.

## Recent changes
Markdown table: Change | Window | Risk | Linked incidents (if any).

## Assessment
One line: Healthy / Degraded / At risk — then the evidence for the verdict and the single most
important action to improve it.`
  }),

  definePromptSpec({
    name: "deploy_impact",
    description:
      "Post-deployment impact check: incident correlation and rollback verdict for a change",
    schema: {
      change_number: z.string().describe("Deployed change to assess (e.g., CHG0005432)")
    },
    build: (a) => `Assess the production impact of deployed change ${a.change_number}.

Gather:
1. get_change for ${a.change_number} — window, affected CIs, backout plan.
2. search_incidents for incidents opened since the change window started on the affected CIs/services.
3. correlate_changes to test which of those incidents plausibly trace back to this change.

Report exactly these sections:

## Change summary
One-row markdown table: Change | Deployed window | Affected CI/service | Risk | Backout plan.

## Incidents since deployment
Markdown table: Number | Priority | Opened | CI | Correlation (likely / possible / unrelated), one line of reasoning each.

## Verdict
One of: clean (no correlated incidents) / suspect (possible correlation) / confirmed impact — with the evidence.

## Recommendation
Keep, monitor, or rollback. If rollback: reference the backout plan and flag it if missing or untested.

Correlation needs evidence (timing + affected CI + symptom match), not coincidence.`
  }),

  definePromptSpec({
    name: "incident_to_backlog",
    description:
      "Sweep resolved incidents lacking ADO links and propose backlog items (write-gated)",
    schema: {
      group_name: z.string().describe("Assignment group to sweep (partial name OK)"),
      days_back: z.coerce
        .number()
        .int()
        .positive()
        .optional()
        .describe("Days to look back (default: 14)")
    },
    build: (
      a
    ) => `Sweep resolved incidents for the ${a.group_name} group from the last ${a.days_back ?? 14} days and propose backlog items for the ones with no follow-up.

Gather:
1. lookup_assignment_groups for '${a.group_name}' to resolve the exact group name(s).
2. search_incidents for the group's incidents resolved in the period.
3. search_work_items to check which incidents already have a linked ADO item.

Report exactly these sections:

## Candidates
Markdown table: Incident | Resolved | Symptom | Existing work item (ID or none). Only incidents worth
a follow-up: recurring symptoms, workaround-only resolutions, missing permanent fixes.

## Proposed backlog items
Markdown table: Incident | Proposed title | Why it deserves a backlog item.

## Next step
For each candidate I approve, call create_bug_from_incident — every write asks for my confirmation
first. Never create items I have not approved.`
  }),

  definePromptSpec({
    name: "sla_review",
    description: "SLA breach and at-risk review with owners, causes, and actions",
    schema: {},
    build: () => `Review the current SLA position: breaches and at-risk incidents.

Gather:
1. find_sla_risks for everything breached or at risk.
2. get_incident on the worst offenders for owner and cause detail.

Report exactly these sections:

## Breached
Markdown table: Incident | Priority | Group | Breached by | Root cause of the delay | Action.

## At risk
Markdown table: Incident | Time remaining | Owner | Recommended action, most urgent first.

## Systemic patterns
Are breaches concentrated in one group, service, or priority band? One short paragraph.

## Recommendations
Up to 3 bullets, each actionable with an owner.

The audience is management: lead with counts and time figures, no jargon, no tool names.`
  }),

  definePromptSpec({
    name: "major_incident_comms",
    description: "Major-incident comms pack: stakeholder update, bridge summary, cadence",
    schema: {
      incident_number: z.string().describe("Major incident (e.g., INC0012345)")
    },
    build: (a) => `Prepare the communications pack for major incident ${a.incident_number}.

Gather:
1. summarize_incident for ${a.incident_number} — status, impact, timeline, related changes.
2. If SharePoint is configured, get_incident_documents for ${a.incident_number} — comms so far, analysis notes.
3. search_knowledge for the major-incident process or comms templates if indexed.

Report exactly these sections:

## Situation summary
One-row markdown table: Incident | Priority | Started | Current state | Impacted service | Users affected.

## Stakeholder update
A ready-to-send draft in plain language: what happened, current impact, what we are doing,
next update time. No jargon, no incident-speak, no blame.

## Technical bridge summary
For engineers joining the bridge: current hypothesis, what has been tried, what is in flight — bullets.

## Comms cadence
Markdown table: Audience | Channel | Frequency | Owner.

## Open questions
What is still unknown and who is finding out — bullets.

Facts only from tool output; mark anything uncertain as uncertain rather than guessing.`
  })
];

/** Lookup by prompt name; throws on unknown so misuse fails loudly at startup/test time. */
export const promptSpec = (name: string): PromptSpec => {
  const spec = PROMPT_SPECS.find((p) => p.name === name);
  if (!spec) throw new Error(`unknown prompt: ${name}`);
  return spec;
};
