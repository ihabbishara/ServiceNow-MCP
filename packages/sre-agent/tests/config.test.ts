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

  it("valid byok config returns the provider block including azure apiVersion", () => {
    const c = loadAgentConfig({
      ...base,
      LLM_MODE: "byok",
      LLM_PROVIDER: "azure",
      LLM_BASE_URL: "https://my-azure-openai.openai.azure.com",
      LLM_API_KEY: "secret-key",
      AZURE_API_VERSION: "2025-01-01"
    });
    expect(c.llm.mode).toBe("byok");
    expect(c.llm.provider).toEqual({
      type: "azure",
      baseUrl: "https://my-azure-openai.openai.azure.com",
      apiKey: "secret-key",
      apiVersion: "2025-01-01"
    });
  });

  it("pat ADO mode does not require ADO_ORG_URL/ADO_PROJECT", () => {
    const c = loadAgentConfig({
      SERVICENOW_BASE_URL: base.SERVICENOW_BASE_URL,
      SERVICENOW_USERNAME: "u",
      SERVICENOW_PASSWORD: "p",
      ADO_AUTH_MODE: "pat"
    });
    expect(c.adoAuthMode).toBe("pat");
  });

  it("CONFIRM_WRITES=false parses to boolean false", () => {
    const c = loadAgentConfig({ ...base, CONFIRM_WRITES: "false" });
    expect(c.confirmWrites).toBe(false);
  });

  it("treats empty-string BYOK vars (the `KEY=` .env form) as unset → seat mode", () => {
    const c = loadAgentConfig({
      ...base,
      LLM_MODE: "seat",
      LLM_PROVIDER: "",
      LLM_BASE_URL: "",
      LLM_API_KEY: ""
    });
    expect(c.llm.mode).toBe("seat");
    expect(c.llm.provider).toBeUndefined();
  });
});
