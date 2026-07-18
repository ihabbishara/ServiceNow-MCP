import { describe, it, expect } from "vitest";
import { buildWorkflowPrompt } from "../src/workflows/index.js";
import { promptSpec } from "@sre/core";

describe("workflows", () => {
  it("/triage builds the triage prompt with the incident number", () => {
    const p = buildWorkflowPrompt("/triage INC0012345");
    expect(p).toContain("INC0012345");
    expect(p).toContain("summarize_incident");
  });

  it("/handover parses team + optional hours", () => {
    const p = buildWorkflowPrompt("/handover Platform SRE 8");
    expect(p).toContain("Platform SRE");
    expect(p).toContain("8 hours");
  });

  it("/handover defaults to 8 hours when none is given", () => {
    const p = buildWorkflowPrompt("/handover Platform SRE");
    expect(p).toContain("Platform SRE");
    expect(p).toContain("8 hours");
  });

  it("/review builds the change review prompt with the change number", () => {
    const p = buildWorkflowPrompt("/review CHG0005432");
    expect(p).toContain("CHG0005432");
    expect(p).toContain("get_change");
  });

  it("/postmortem builds the postmortem prompt with the incident number", () => {
    const p = buildWorkflowPrompt("/postmortem INC0012345");
    expect(p).toContain("INC0012345");
    expect(p).toContain("summarize_incident");
    expect(p).toContain("postmortem");
  });

  it("/rca builds the RCA prompt with the incident number", () => {
    const p = buildWorkflowPrompt("/rca INC0012345");
    expect(p).toContain("INC0012345");
    expect(p).toContain("summarize_incident");
    expect(p).toContain("correlate_changes");
  });

  it("/release-readiness parses optional days and defaults to 7", () => {
    expect(buildWorkflowPrompt("/release-readiness 14")).toContain("next 14 days");
    expect(buildWorkflowPrompt("/release-readiness")).toContain("next 7 days");
  });

  it("/ops-report parses optional days and defaults to 7", () => {
    expect(buildWorkflowPrompt("/ops-report 30")).toContain("last 30 days");
    expect(buildWorkflowPrompt("/ops-report")).toContain("last 7 days");
  });

  it("/queue-hygiene takes a group name with spaces", () => {
    const p = buildWorkflowPrompt("/queue-hygiene Platform SRE");
    expect(p).toContain("Platform SRE");
    expect(p).toContain("find_stale_tickets");
  });

  it("/recurring parses subject with spaces + optional trailing days", () => {
    const p = buildWorkflowPrompt("/recurring Platform SRE 60");
    expect(p).toContain("Platform SRE");
    expect(p).toContain("last 60 days");
    expect(buildWorkflowPrompt("/recurring GIOM")).toContain("last 30 days");
  });

  it("/health parses service + optional trailing days", () => {
    expect(buildWorkflowPrompt("/health payments-api 90")).toContain("last 90 days");
    expect(buildWorkflowPrompt("/health payments-api")).toContain("last 30 days");
  });

  it("/deploy-impact builds the deploy-impact prompt with the change number", () => {
    const p = buildWorkflowPrompt("/deploy-impact CHG0005432");
    expect(p).toContain("CHG0005432");
    expect(p).toContain("correlate_changes");
  });

  it("/incident-to-backlog parses group + optional trailing days", () => {
    const p = buildWorkflowPrompt("/incident-to-backlog Platform SRE 30");
    expect(p).toContain("Platform SRE");
    expect(p).toContain("last 30 days");
    expect(buildWorkflowPrompt("/incident-to-backlog GIOM")).toContain("last 14 days");
  });

  it("/sla-review takes no arguments", () => {
    expect(buildWorkflowPrompt("/sla-review")).toContain("find_sla_risks");
  });

  it("/mim builds the major-incident comms prompt", () => {
    const p = buildWorkflowPrompt("/mim INC0012345");
    expect(p).toContain("INC0012345");
    expect(p).toContain("Stakeholder update");
  });

  it("returns null for non-workflow input", () => {
    expect(buildWorkflowPrompt("hello")).toBeNull();
  });

  it("returns null for an unknown slash command", () => {
    expect(buildWorkflowPrompt("/unknown thing")).toBeNull();
  });

  it("every workflow prompt steers the model to search_knowledge", () => {
    expect(buildWorkflowPrompt("/triage INC1")).toContain("search_knowledge");
    expect(buildWorkflowPrompt("/review CHG1")).toContain("search_knowledge");
    expect(buildWorkflowPrompt("/postmortem INC1")).toContain("search_knowledge");
    expect(buildWorkflowPrompt("/handover Platform SRE")).toContain("search_knowledge");
  });
});

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
    expect(buildWorkflowPrompt("/rca INC1")).toBe(
      promptSpec("incident_rca").build({ incident_number: "INC1" })
    );
    expect(buildWorkflowPrompt("/release-readiness 14")).toBe(
      promptSpec("release_readiness").build({ days_ahead: 14 })
    );
    expect(buildWorkflowPrompt("/release-readiness")).toBe(
      promptSpec("release_readiness").build({})
    );
    expect(buildWorkflowPrompt("/ops-report 30")).toBe(
      promptSpec("ops_report").build({ days_back: 30 })
    );
    expect(buildWorkflowPrompt("/ops-report")).toBe(promptSpec("ops_report").build({}));
    expect(buildWorkflowPrompt("/queue-hygiene Platform SRE")).toBe(
      promptSpec("queue_hygiene").build({ group_name: "Platform SRE" })
    );
    expect(buildWorkflowPrompt("/recurring Platform SRE 60")).toBe(
      promptSpec("recurring_incidents").build({ subject: "Platform SRE", days_back: 60 })
    );
    expect(buildWorkflowPrompt("/health payments-api")).toBe(
      promptSpec("service_health").build({ service: "payments-api" })
    );
    expect(buildWorkflowPrompt("/deploy-impact CHG1")).toBe(
      promptSpec("deploy_impact").build({ change_number: "CHG1" })
    );
    expect(buildWorkflowPrompt("/incident-to-backlog GIOM 30")).toBe(
      promptSpec("incident_to_backlog").build({ group_name: "GIOM", days_back: 30 })
    );
    expect(buildWorkflowPrompt("/sla-review")).toBe(promptSpec("sla_review").build({}));
    expect(buildWorkflowPrompt("/mim INC1")).toBe(
      promptSpec("major_incident_comms").build({ incident_number: "INC1" })
    );
  });
});
