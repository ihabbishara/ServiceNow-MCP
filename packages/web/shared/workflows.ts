// packages/web/shared/workflows.ts
//
// Workflow catalog for the web UI: slash command → persona category + hover
// description. Descriptions mirror core PROMPT_SPECS verbatim — the client
// cannot import @sre/core (node-only deps), so the sync is enforced by
// tests/workflow-catalog.test.ts instead.

export const WORKFLOW_CATEGORIES = ["SRE", "DevOps", "Management", "Incident Management"] as const;

export type WorkflowCategory = (typeof WORKFLOW_CATEGORIES)[number];

export interface WorkflowEntry {
  command: string;
  /** Core PROMPT_SPECS name this command builds. */
  prompt: string;
  category: WorkflowCategory;
  /** Shown after the command in the UI, e.g. "<INC>". */
  argHint: string;
  /** Example args for the parity test; empty when the command takes none. */
  sampleArgs: string;
  /** Mirrors the core registry description — the catalog test enforces the sync. */
  description: string;
}

export const WORKFLOW_CATALOG: WorkflowEntry[] = [
  // SRE
  {
    command: "/rca",
    prompt: "incident_rca",
    category: "SRE",
    argHint: "<INC>",
    sampleArgs: "INC0012345",
    description: "Full root-cause analysis for an incident: evidence, change correlation, verdict"
  },
  {
    command: "/recurring",
    prompt: "recurring_incidents",
    category: "SRE",
    argHint: "<subject> [days]",
    sampleArgs: "GIOM 30",
    description: "Cluster repeat incidents into problem-record candidates with permanent fixes"
  },
  {
    command: "/health",
    prompt: "service_health",
    category: "SRE",
    argHint: "<service> [days]",
    sampleArgs: "payments-api",
    description: "Service scorecard: incident trend, top categories, change activity, verdict"
  },
  {
    command: "/handover",
    prompt: "shift_handover",
    category: "SRE",
    argHint: "<team> [hours]",
    sampleArgs: "Platform SRE 8",
    description: "Generate comprehensive shift handover summary"
  },

  // DevOps
  {
    command: "/review",
    prompt: "change_review",
    category: "DevOps",
    argHint: "<CHG>",
    sampleArgs: "CHG0005432",
    description: "Review a change for potential risks and issues"
  },
  {
    command: "/release-readiness",
    prompt: "release_readiness",
    category: "DevOps",
    argHint: "[days]",
    sampleArgs: "7",
    description:
      "Go/No-Go assessment of upcoming changes: conflicts, backout plans, incident exposure"
  },
  {
    command: "/deploy-impact",
    prompt: "deploy_impact",
    category: "DevOps",
    argHint: "<CHG>",
    sampleArgs: "CHG0005432",
    description:
      "Post-deployment impact check: incident correlation and rollback verdict for a change"
  },
  {
    command: "/incident-to-backlog",
    prompt: "incident_to_backlog",
    category: "DevOps",
    argHint: "<group> [days]",
    sampleArgs: "GIOM 14",
    description:
      "Sweep resolved incidents lacking ADO links and propose backlog items (write-gated)"
  },

  // Management
  {
    command: "/ops-report",
    prompt: "ops_report",
    category: "Management",
    argHint: "[days]",
    sampleArgs: "7",
    description: "Management-facing operations report: volumes, SLA status, trends, recommendations"
  },
  {
    command: "/sla-review",
    prompt: "sla_review",
    category: "Management",
    argHint: "",
    sampleArgs: "",
    description: "SLA breach and at-risk review with owners, causes, and actions"
  },

  // Incident Management
  {
    command: "/triage",
    prompt: "incident_triage",
    category: "Incident Management",
    argHint: "<INC>",
    sampleArgs: "INC0012345",
    description: "Guide through systematic incident triage process"
  },
  {
    command: "/postmortem",
    prompt: "incident_postmortem",
    category: "Incident Management",
    argHint: "<INC>",
    sampleArgs: "INC0012345",
    description: "Structure a post-incident review discussion"
  },
  {
    command: "/queue-hygiene",
    prompt: "queue_hygiene",
    category: "Incident Management",
    argHint: "<group>",
    sampleArgs: "GIOM",
    description:
      "Queue cleanup review for an assignment group: unassigned, stale, misprioritized, SLA risk"
  },
  {
    command: "/mim",
    prompt: "major_incident_comms",
    category: "Incident Management",
    argHint: "<INC>",
    sampleArgs: "INC0012345",
    description: "Major-incident comms pack: stakeholder update, bridge summary, cadence"
  }
];
