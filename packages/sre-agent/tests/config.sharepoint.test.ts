import { describe, it, expect } from "vitest";
import { loadAgentConfig } from "../src/config.js";

const base = {
  SERVICENOW_BASE_URL: "https://x.service-now.com",
  SERVICENOW_USERNAME: "u",
  SERVICENOW_PASSWORD: "p",
  ADO_ORG_URL: "https://dev.azure.com/INGCDaaS",
  ADO_PROJECT: "IngOne"
};

describe("sharePointEnabled flag", () => {
  it("false by default", () => {
    expect(loadAgentConfig(base).sharePointEnabled).toBe(false);
  });
  it("true when SHAREPOINT_ENABLED=true (with required SHAREPOINT_SITE_URL)", () => {
    expect(
      loadAgentConfig({ ...base, SHAREPOINT_ENABLED: "true", SHAREPOINT_SITE_URL: "https://tenant.sharepoint.com/sites/sre" }).sharePointEnabled
    ).toBe(true);
  });
});
