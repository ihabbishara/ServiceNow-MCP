import { promptSpec } from "@sre/core";

/**
 * Workflow commands for the REPL.
 *
 * `buildWorkflowPrompt(line)` maps a leading slash command to a seed prompt
 * built from the core PROMPT_SPECS registry — the same specs the MCP server
 * registers as prompts, so the two surfaces cannot drift. Any non-slash line
 * or unknown command returns `null` so the CLI sends the raw line instead.
 */
/**
 * Group/team/service args may contain spaces; a trailing integer (if present)
 * is a days/hours value. Everything before it is the textual argument.
 */
const splitTrailingInt = (arg: string): { text: string; n?: number } => {
  const m = arg.match(/^(.*?)(?:\s+(\d+))?$/);
  return { text: (m?.[1] ?? arg).trim(), ...(m?.[2] ? { n: Number(m[2]) } : {}) };
};

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
      const { text, n } = splitTrailingInt(arg);
      return promptSpec("shift_handover").build({
        team_name: text,
        ...(n !== undefined ? { hours_back: n } : {})
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
    case "/recurring": {
      const { text, n } = splitTrailingInt(arg);
      return promptSpec("recurring_incidents").build({
        subject: text,
        ...(n !== undefined ? { days_back: n } : {})
      });
    }
    case "/health": {
      const { text, n } = splitTrailingInt(arg);
      return promptSpec("service_health").build({
        service: text,
        ...(n !== undefined ? { days_back: n } : {})
      });
    }
    case "/deploy-impact":
      return promptSpec("deploy_impact").build({ change_number: arg });
    case "/incident-to-backlog": {
      const { text, n } = splitTrailingInt(arg);
      return promptSpec("incident_to_backlog").build({
        group_name: text,
        ...(n !== undefined ? { days_back: n } : {})
      });
    }
    case "/sla-review":
      return promptSpec("sla_review").build({});
    case "/mim":
      return promptSpec("major_incident_comms").build({ incident_number: arg });
    default:
      return null;
  }
};
