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

  it("Copilot seat auth fields are undefined by default", () => {
    const c = loadAgentConfig({ ...base });
    expect(c.copilot.githubToken).toBeUndefined();
    expect(c.copilot.home).toBeUndefined();
  });

  it("exposes COPILOT_GITHUB_TOKEN as copilot.githubToken (explicit seat token)", () => {
    const c = loadAgentConfig({ ...base, COPILOT_GITHUB_TOKEN: "gho_abc123" });
    expect(c.copilot.githubToken).toBe("gho_abc123");
  });

  it("exposes COPILOT_HOME as copilot.home (points the SDK runtime at the CLI's store)", () => {
    const c = loadAgentConfig({ ...base, COPILOT_HOME: "C:\\Users\\me\\.copilot" });
    expect(c.copilot.home).toBe("C:\\Users\\me\\.copilot");
  });

  it("treats empty-string Copilot auth vars (the `KEY=` .env form) as unset", () => {
    const c = loadAgentConfig({ ...base, COPILOT_GITHUB_TOKEN: "", COPILOT_HOME: "" });
    expect(c.copilot.githubToken).toBeUndefined();
    expect(c.copilot.home).toBeUndefined();
  });

  it("defaults to ignoring ambient GitHub env tokens (use the copilot-login OAuth)", () => {
    const c = loadAgentConfig({ ...base });
    expect(c.copilot.ignoreEnvToken).toBe(true);
  });

  it("COPILOT_IGNORE_ENV_TOKEN=false opts back into ambient env-token auth", () => {
    const c = loadAgentConfig({ ...base, COPILOT_IGNORE_ENV_TOKEN: "false" });
    expect(c.copilot.ignoreEnvToken).toBe(false);
  });

  it("knowledgeEnabled is false when CRAWL_SEEDS is unset/empty", () => {
    expect(loadAgentConfig({ ...base }).knowledgeEnabled).toBe(false);
    expect(loadAgentConfig({ ...base, CRAWL_SEEDS: "   " }).knowledgeEnabled).toBe(false);
  });

  it("knowledgeEnabled is true when CRAWL_SEEDS is set", () => {
    expect(loadAgentConfig({ ...base, CRAWL_SEEDS: "https://wiki.acme.io/a" }).knowledgeEnabled).toBe(true);
  });

  describe("uploadMaxBytes", () => {
    it("defaults to 10 MB", () => {
      expect(loadAgentConfig(base).uploadMaxBytes).toBe(10485760);
    });
    it("reads UPLOAD_MAX_BYTES", () => {
      expect(loadAgentConfig({ ...base, UPLOAD_MAX_BYTES: "2048" }).uploadMaxBytes).toBe(2048);
    });
  });
});
