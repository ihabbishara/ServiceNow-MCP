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
    case "/rca":
      return promptSpec("incident_rca").build({ incident_number: arg });
    case "/release-readiness":
      return promptSpec("release_readiness").build(arg ? { days_ahead: Number(arg) } : {});
    case "/ops-report":
      return promptSpec("ops_report").build(arg ? { days_back: Number(arg) } : {});
    case "/queue-hygiene":
      return promptSpec("queue_hygiene").build({ group_name: arg });
    default:
      return null;
  }
};
