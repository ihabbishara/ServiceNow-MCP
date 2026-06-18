import { describe, it, expect } from "vitest";
import { buildEnvFile } from "../src/init.js";

const template = [
  "# header comment",
  "SERVICENOW_BASE_URL=https://acme.service-now.com   # instance base URL",
  "SERVICENOW_PASSWORD=change-me                        # password (SECRET)",
  "# LLM_PROVIDER=azure                                # commented-out var",
  "ADO_PROJECT=IngOne                                   # required in azcli mode"
].join("\n");

describe("buildEnvFile", () => {
  it("replaces an answered key's value and drops the inline comment on that line", () => {
    const out = buildEnvFile(template, {
      SERVICENOW_BASE_URL: "https://ing.service-now.com"
    });
    expect(out).toContain("SERVICENOW_BASE_URL=https://ing.service-now.com");
    // the inline comment is dropped from the answered line to avoid parser ambiguity
    expect(out).not.toContain("SERVICENOW_BASE_URL=https://ing.service-now.com   # instance");
  });

  it("quotes values containing spaces, # or = (e.g. a password)", () => {
    const out = buildEnvFile(template, { SERVICENOW_PASSWORD: "p@ss #1 word" });
    expect(out).toContain('SERVICENOW_PASSWORD="p@ss #1 word"');
  });

  it("leaves unanswered lines — including commented-out vars — untouched", () => {
    const out = buildEnvFile(template, { ADO_PROJECT: "IngOne" });
    expect(out).toContain("# LLM_PROVIDER=azure                                # commented-out var");
    expect(out).toContain("SERVICENOW_PASSWORD=change-me                        # password (SECRET)");
  });

  it("appends answered keys that are absent from the template", () => {
    const out = buildEnvFile(template, { COPILOT_HOME: "/home/me/.copilot" });
    expect(out).toContain("COPILOT_HOME=/home/me/.copilot");
    expect(out.indexOf("COPILOT_HOME")).toBeGreaterThan(out.indexOf("ADO_PROJECT"));
  });

  it("does not quote a simple value with no special characters", () => {
    const out = buildEnvFile(template, { ADO_PROJECT: "IngOne" });
    expect(out).toContain("ADO_PROJECT=IngOne");
    expect(out).not.toContain('ADO_PROJECT="IngOne"');
  });
});
