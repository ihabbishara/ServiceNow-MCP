import { describe, it, expect } from "vitest";
import { loadAgentConfig } from "../src/config.js";

const base = {
  SERVICENOW_BASE_URL: "https://x.service-now.com",
  SERVICENOW_USERNAME: "u",
  SERVICENOW_PASSWORD: "p",
  ADO_ORG_URL: "https://dev.azure.com/INGCDaaS",
  ADO_PROJECT: "IngOne"
};

describe("loadAgentConfig", () => {
  it("defaults to seat mode, gpt-5, azcli ADO, confirm writes", () => {
    const c = loadAgentConfig({ ...base });
    expect(c.llm.mode).toBe("seat");
    expect(c.llm.model).toBe("gpt-5");
    expect(c.adoAuthMode).toBe("azcli");
    expect(c.confirmWrites).toBe(true);
  });

  it("byok requires model + provider block", () => {
    expect(() => loadAgentConfig({ ...base, LLM_MODE: "byok" })).toThrow(/byok/i);
  });

  it("azcli requires ADO_ORG_URL and ADO_PROJECT", () => {
    expect(() =>
      loadAgentConfig({
        SERVICENOW_BASE_URL: base.SERVICENOW_BASE_URL,
        SERVICENOW_USERNAME: "u",
        SERVICENOW_PASSWORD: "p"
      })
    ).toThrow(/ADO_ORG_URL/);
  });
});
