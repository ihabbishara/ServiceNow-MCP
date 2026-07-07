import { describe, it, expect } from "vitest";
import { PROMPT_SPECS, promptSpec } from "../../src/prompts/registry.js";

describe("PROMPT_SPECS registry", () => {
  it("holds exactly the workflow prompts with unique names and metadata", () => {
    expect(PROMPT_SPECS.map((p) => p.name)).toEqual([
      "incident_triage",
      "shift_handover",
      "change_review",
      "incident_postmortem",
      "code_analysis"
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
