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
  })
];

/** Lookup by prompt name; throws on unknown so misuse fails loudly at startup/test time. */
export const promptSpec = (name: string): PromptSpec => {
  const spec = PROMPT_SPECS.find((p) => p.name === name);
  if (!spec) throw new Error(`unknown prompt: ${name}`);
  return spec;
};
