import { describe, it, expect } from "vitest";
import { WORKFLOW_CATALOG, WORKFLOW_CATEGORIES } from "../shared/workflows.js";
import { PROMPT_SPECS } from "@sre/core";
import { buildWorkflowPrompt } from "@sre/sre-agent";

describe("workflow catalog", () => {
  it("covers every registry prompt except the code_analysis sub-agent playbook", () => {
    const catalogPrompts = WORKFLOW_CATALOG.map((w) => w.prompt).sort();
    const registryPrompts = PROMPT_SPECS.map((p) => p.name)
      .filter((n) => n !== "code_analysis")
      .sort();
    expect(catalogPrompts).toEqual(registryPrompts);
  });

  it("descriptions stay in sync with the core registry (single source of truth)", () => {
    for (const entry of WORKFLOW_CATALOG) {
      const spec = PROMPT_SPECS.find((p) => p.name === entry.prompt);
      expect(spec, `unknown prompt ${entry.prompt}`).toBeDefined();
      expect(entry.description, `description drift for ${entry.command}`).toBe(spec!.description);
    }
  });

  it("every command parses through buildWorkflowPrompt with its sample args", () => {
    for (const entry of WORKFLOW_CATALOG) {
      const line = entry.sampleArgs ? `${entry.command} ${entry.sampleArgs}` : entry.command;
      expect(buildWorkflowPrompt(line), `${entry.command} did not parse`).not.toBeNull();
    }
  });

  it("groups into exactly the four personas, each non-empty", () => {
    expect(WORKFLOW_CATEGORIES).toEqual(["SRE", "DevOps", "Management", "Incident Management"]);
    for (const cat of WORKFLOW_CATEGORIES) {
      expect(
        WORKFLOW_CATALOG.some((w) => w.category === cat),
        `empty category ${cat}`
      ).toBe(true);
    }
  });
});
