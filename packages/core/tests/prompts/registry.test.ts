import { describe, it, expect } from "vitest";
import { PROMPT_SPECS, promptSpec } from "../../src/prompts/registry.js";

describe("PROMPT_SPECS registry", () => {
  it("holds exactly the workflow prompts with unique names and metadata", () => {
    expect(PROMPT_SPECS.map((p) => p.name)).toEqual([
      "incident_triage",
      "shift_handover",
      "change_review",
      "incident_postmortem",
      "code_analysis",
      "incident_rca",
      "release_readiness",
      "ops_report",
      "queue_hygiene",
      "recurring_incidents",
      "service_health",
      "deploy_impact",
      "incident_to_backlog",
      "sla_review",
      "major_incident_comms"
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

  it("triage prompt offers proactive code analysis on code signals", () => {
    const text = promptSpec("incident_triage").build({ incident_number: "INC0012345" });
    expect(text).toContain("codeAnalysis");
    expect(text).toContain("codebase root-cause analysis");
    expect(text).toContain("repo clone URL");
  });

  it("shift_handover interpolates team + hours and defaults hours to 8", () => {
    const withHours = promptSpec("shift_handover").build({
      team_name: "Platform SRE",
      hours_back: 12
    });
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

describe("golden workflow prompts", () => {
  it("incident_rca interpolates the incident and drives the full evidence chain", () => {
    const text = promptSpec("incident_rca").build({ incident_number: "INC0012345" });
    expect(text).toContain("INC0012345");
    for (const tool of ["summarize_incident", "correlate_changes", "search_knowledge"]) {
      expect(text).toContain(tool);
    }
    expect(text).toContain("get_incident_documents");
    expect(text).toContain("analyze_code");
    for (const section of [
      "## Incident snapshot",
      "## Change correlation",
      "## Root-cause hypothesis",
      "## Remediation",
      "## Confidence"
    ]) {
      expect(text).toContain(section);
    }
    expect(text).toMatch(/markdown table/i);
  });

  it("release_readiness interpolates the look-ahead window and defaults to 7 days", () => {
    const custom = promptSpec("release_readiness").build({ days_ahead: 14 });
    expect(custom).toContain("next 14 days");
    const defaulted = promptSpec("release_readiness").build({});
    expect(defaulted).toContain("next 7 days");
    for (const tool of ["search_changes", "get_change", "search_incidents"]) {
      expect(defaulted).toContain(tool);
    }
    for (const section of ["## Change calendar", "## Conflicts", "## Go / No-Go"]) {
      expect(defaulted).toContain(section);
    }
    expect(defaulted).toMatch(/markdown table/i);
    expect(defaulted).toContain("backout");
  });

  it("ops_report interpolates the look-back window, defaults to 7 days, and targets management", () => {
    const custom = promptSpec("ops_report").build({ days_back: 30 });
    expect(custom).toContain("last 30 days");
    const defaulted = promptSpec("ops_report").build({});
    expect(defaulted).toContain("last 7 days");
    for (const tool of [
      "generate_ops_summary",
      "search_incidents",
      "find_sla_risks",
      "search_changes"
    ]) {
      expect(defaulted).toContain(tool);
    }
    for (const section of ["## Executive summary", "## Incident volume", "## Recommendations"]) {
      expect(defaulted).toContain(section);
    }
    expect(defaulted).toMatch(/markdown table/i);
    expect(defaulted).toContain("management");
  });

  it("queue_hygiene interpolates the group, resolves it, and stays recommend-only", () => {
    const text = promptSpec("queue_hygiene").build({ group_name: "Platform SRE" });
    expect(text).toContain("Platform SRE");
    for (const tool of [
      "lookup_assignment_groups",
      "search_incidents",
      "find_stale_tickets",
      "find_sla_risks"
    ]) {
      expect(text).toContain(tool);
    }
    for (const section of [
      "## Unassigned",
      "## Stale",
      "## Misprioritized",
      "## Cleanup actions"
    ]) {
      expect(text).toContain(section);
    }
    expect(text).toMatch(/markdown table/i);
    // No ServiceNow write tools exist; the workflow must not promise writes.
    expect(text).toContain("ServiceNow");
  });
});

describe("persona workflow prompts (second wave)", () => {
  it("recurring_incidents interpolates subject + window and hunts problem candidates", () => {
    const text = promptSpec("recurring_incidents").build({ subject: "GIOM", days_back: 60 });
    expect(text).toContain("GIOM");
    expect(text).toContain("last 60 days");
    const defaulted = promptSpec("recurring_incidents").build({ subject: "GIOM" });
    expect(defaulted).toContain("last 30 days");
    for (const tool of ["search_incidents", "search_knowledge"]) {
      expect(defaulted).toContain(tool);
    }
    for (const section of ["## Clusters", "## Problem-record candidates", "## Runbook coverage"]) {
      expect(defaulted).toContain(section);
    }
    expect(defaulted).toMatch(/markdown table/i);
  });

  it("service_health interpolates service + window and yields a verdict", () => {
    const text = promptSpec("service_health").build({ service: "payments-api", days_back: 90 });
    expect(text).toContain("payments-api");
    expect(text).toContain("last 90 days");
    const defaulted = promptSpec("service_health").build({ service: "payments-api" });
    expect(defaulted).toContain("last 30 days");
    for (const tool of ["search_incidents", "search_changes", "find_sla_risks"]) {
      expect(defaulted).toContain(tool);
    }
    for (const section of ["## Scorecard", "## Top categories", "## Assessment"]) {
      expect(defaulted).toContain(section);
    }
    expect(defaulted).toMatch(/markdown table/i);
  });

  it("deploy_impact interpolates the change and demands a rollback verdict", () => {
    const text = promptSpec("deploy_impact").build({ change_number: "CHG0005432" });
    expect(text).toContain("CHG0005432");
    for (const tool of ["get_change", "correlate_changes", "search_incidents"]) {
      expect(text).toContain(tool);
    }
    for (const section of [
      "## Change summary",
      "## Incidents since deployment",
      "## Verdict",
      "## Recommendation"
    ]) {
      expect(text).toContain(section);
    }
    expect(text).toMatch(/markdown table/i);
    expect(text).toContain("rollback");
  });

  it("incident_to_backlog interpolates group + window and gates writes on approval", () => {
    const text = promptSpec("incident_to_backlog").build({
      group_name: "Platform SRE",
      days_back: 30
    });
    expect(text).toContain("Platform SRE");
    expect(text).toContain("last 30 days");
    const defaulted = promptSpec("incident_to_backlog").build({ group_name: "Platform SRE" });
    expect(defaulted).toContain("last 14 days");
    for (const tool of [
      "lookup_assignment_groups",
      "search_incidents",
      "search_work_items",
      "create_bug_from_incident"
    ]) {
      expect(defaulted).toContain(tool);
    }
    for (const section of ["## Candidates", "## Proposed backlog items"]) {
      expect(defaulted).toContain(section);
    }
    expect(defaulted).toMatch(/markdown table/i);
    expect(defaulted).toContain("approve");
  });

  it("sla_review takes no args and targets management", () => {
    const text = promptSpec("sla_review").build({});
    for (const tool of ["find_sla_risks", "get_incident"]) {
      expect(text).toContain(tool);
    }
    for (const section of ["## Breached", "## At risk", "## Recommendations"]) {
      expect(text).toContain(section);
    }
    expect(text).toMatch(/markdown table/i);
    expect(text).toContain("management");
  });

  it("major_incident_comms interpolates the incident and drafts stakeholder comms", () => {
    const text = promptSpec("major_incident_comms").build({ incident_number: "INC0012345" });
    expect(text).toContain("INC0012345");
    for (const tool of ["summarize_incident", "get_incident_documents", "search_knowledge"]) {
      expect(text).toContain(tool);
    }
    for (const section of [
      "## Situation summary",
      "## Stakeholder update",
      "## Technical bridge summary",
      "## Comms cadence"
    ]) {
      expect(text).toContain(section);
    }
    expect(text).toMatch(/markdown table/i);
    expect(text).toContain("plain language");
  });
});

describe("code_analysis prompt", () => {
  it("embeds the repo URL, error text, ref, and incident and names the repo tools", () => {
    const text = promptSpec("code_analysis").build({
      repo_url: "https://dev.azure.com/Org/P/_git/pay",
      error_text: "TypeError: Cannot read properties of undefined at charge (charge.ts:42)",
      incident_number: "INC0012345",
      ref: "release/1.2"
    });
    expect(text).toContain("https://dev.azure.com/Org/P/_git/pay");
    expect(text).toContain("charge.ts:42");
    expect(text).toContain("release/1.2");
    expect(text).toContain("INC0012345");
    for (const tool of ["checkout_repo", "search_repo", "read_repo_file", "repo_history"]) {
      expect(text).toContain(tool);
    }
    expect(text).toContain("## Suspects");
    expect(text).toContain("## Confidence");
  });

  it("omits incident/ref lines when not provided", () => {
    const text = promptSpec("code_analysis").build({
      repo_url: "https://dev.azure.com/Org/P/_git/pay",
      error_text: "boom"
    });
    expect(text).not.toContain("Incident:");
    expect(text).not.toContain("ref:");
  });
});
