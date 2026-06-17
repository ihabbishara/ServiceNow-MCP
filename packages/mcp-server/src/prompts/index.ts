import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { McpRuntime } from "@sre/core";

export const registerPrompts = (server: McpServer, _runtime: McpRuntime): void => {
  // incident_triage - Guide through incident triage
  server.prompt(
    "incident_triage",
    "Guide through systematic incident triage process",
    {
      incident_number: z.string().describe("Incident to triage (e.g., INC0012345)")
    },
    async (args) => {
      const incidentNumber = args.incident_number;

      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Help me triage incident ${incidentNumber}.

First, use the summarize_incident tool to get full context including related changes.

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
            }
          }
        ]
      };
    }
  );

  // shift_handover - Generate handover summary
  server.prompt(
    "shift_handover",
    "Generate comprehensive shift handover summary",
    {
      team_name: z.string().describe("Team to generate handover for"),
      hours_back: z.coerce.number().int().positive().optional().describe("Hours to look back (default: 8)")
    },
    async (args) => {
      const teamName = args.team_name;
      const hoursBack = args.hours_back ?? 8;

      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Generate a shift handover summary for the ${teamName} team, covering the last ${hoursBack} hours.

Use these tools to gather information:
1. search_incidents - find all open incidents for the team
2. find_sla_risks - identify any SLA risks
3. find_stale_tickets - find tickets needing updates
4. search_changes - find changes in the time period

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
            }
          }
        ]
      };
    }
  );

  // change_review - Review a change for risks
  server.prompt(
    "change_review",
    "Review a change for potential risks and issues",
    {
      change_number: z.string().describe("Change to review (e.g., CHG0005432)")
    },
    async (args) => {
      const changeNumber = args.change_number;

      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Review change ${changeNumber} for potential risks and issues.

First, use get_change to get the full change details.

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
            }
          }
        ]
      };
    }
  );

  // incident_postmortem - Structure postmortem discussion
  server.prompt(
    "incident_postmortem",
    "Structure a post-incident review discussion",
    {
      incident_number: z.string().describe("Incident for postmortem (e.g., INC0012345)")
    },
    async (args) => {
      const incidentNumber = args.incident_number;

      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: `Help me structure a postmortem for incident ${incidentNumber}.

First, use summarize_incident to get full context including timeline and related changes.

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
            }
          }
        ]
      };
    }
  );
};
