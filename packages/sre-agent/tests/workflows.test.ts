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
  });
});
