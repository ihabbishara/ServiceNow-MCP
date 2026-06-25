/**
 * Workflow commands for the REPL.
 *
 * `buildWorkflowPrompt(line)` maps a leading slash command to a seed prompt that
 * tells the model which tools to call and how to structure the answer. The four
 * prompt bodies are ported VERBATIM from the MCP prompt templates in
 * `packages/mcp-server/src/prompts/index.ts` (only parameterized by the
 * incident/change/team/hours value). Any non-slash line or unknown command
 * returns `null` so the CLI sends the raw line instead.
 */

const triagePrompt = (incidentNumber: string): string =>
  `Help me triage incident ${incidentNumber}.

First, use the summarize_incident tool to get full context including related changes.

If internal documentation is indexed, also call search_knowledge to find runbooks or known fixes for these symptoms, and cite the source URLs in your recommendations.

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

Be concise and actionable. Focus on what to do now.`;

const handoverPrompt = (teamName: string, hoursBack: string): string =>
  `Generate a shift handover summary for the ${teamName} team, covering the last ${hoursBack} hours.

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

Keep it actionable and prioritized. The incoming shift should know exactly what to focus on first.`;

const reviewPrompt = (changeNumber: string): string =>
  `Review change ${changeNumber} for potential risks and issues.

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

Be thorough but concise.`;

const postmortemPrompt = (incidentNumber: string): string =>
  `Help me structure a postmortem for incident ${incidentNumber}.

First, use summarize_incident to get full context including timeline and related changes.

Also call search_knowledge to check for an existing runbook or known issue for this failure, and flag any runbook gaps as action items.

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

Focus on learning and prevention, not blame.`;

export const buildWorkflowPrompt = (line: string): string | null => {
  const [cmd, ...rest] = line.trim().split(/\s+/);
  const arg = rest.join(" ");
  switch (cmd) {
    case "/triage":
      return triagePrompt(arg);
    case "/review":
      return reviewPrompt(arg);
    case "/postmortem":
      return postmortemPrompt(arg);
    case "/handover": {
      // Team names can contain spaces; a trailing integer (if present) is the
      // hours-back value. Everything before it is the team name. Default 8.
      const m = arg.match(/^(.*?)(?:\s+(\d+))?$/);
      const team = (m?.[1] ?? arg).trim();
      const hours = m?.[2] ?? "8";
      return handoverPrompt(team, hours);
    }
    default:
      return null;
  }
};
