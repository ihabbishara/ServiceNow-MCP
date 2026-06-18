import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

const validEnv = {
  SERVICENOW_BASE_URL: "https://example.service-now.com",
  SERVICENOW_USERNAME: "api.user",
  SERVICENOW_PASSWORD: "secret"
};

describe("loadConfig", () => {
  it("loads minimal config with defaults", () => {
    const cfg = loadConfig(validEnv);
    expect(cfg.serviceNow.enabled).toBe(true);
    expect(cfg.serviceNow.baseUrl).toBe("https://example.service-now.com");
    expect(cfg.azureDevOps.enabled).toBe(false);
    expect(cfg.features.createAdoBug).toBe(true);
    expect(cfg.thresholds.staleByPriorityMinutes).toEqual({ "1": 30, "2": 120, "3": 1440, "4": 4320 });
    expect(cfg.thresholds.relatedChangeWindow).toEqual({ beforeHours: 24, afterHours: 4 });
  });

  it("strips trailing slash from base URL", () => {
    const cfg = loadConfig({ ...validEnv, SERVICENOW_BASE_URL: "https://example.service-now.com/" });
    expect(cfg.serviceNow.baseUrl).toBe("https://example.service-now.com");
  });

  it("throws naming the missing required vars", () => {
    expect(() => loadConfig({})).toThrow(/SERVICENOW_BASE_URL/);
    expect(() => loadConfig({})).toThrow(/SERVICENOW_USERNAME/);
  });

  it("requires ADO vars when ADO_ENABLED=true", () => {
    expect(() => loadConfig({ ...validEnv, ADO_ENABLED: "true" })).toThrow(/ADO_ORG_URL, ADO_PROJECT, and ADO_PAT/);
  });

  it("accepts full ADO config, defaults paths to project name", () => {
    const cfg = loadConfig({
      ...validEnv,
      ADO_ENABLED: "true",
      ADO_ORG_URL: "https://dev.azure.com/acme",
      ADO_PROJECT: "Platform",
      ADO_PAT: "pat123"
    });
    expect(cfg.azureDevOps.enabled).toBe(true);
    expect(cfg.azureDevOps.defaultAreaPath).toBe("Platform");
    expect(cfg.azureDevOps.defaultIterationPath).toBe("Platform");
  });

  it("treats empty ADO path overrides as unset, falling back to project", () => {
    const cfg = loadConfig({
      ...validEnv,
      ADO_ENABLED: "true",
      ADO_ORG_URL: "https://dev.azure.com/acme",
      ADO_PROJECT: "Platform",
      ADO_PAT: "pat123",
      ADO_AREA_PATH: "",
      ADO_ITERATION_PATH: ""
    });
    expect(cfg.azureDevOps.defaultAreaPath).toBe("Platform");
    expect(cfg.azureDevOps.defaultIterationPath).toBe("Platform");
  });

  it("treats empty ADO_PAT/ADO_PROJECT/ADO_ORG_URL (the `KEY=` .env form) as unset when ADO is disabled", () => {
    // Regression: `ADO_PAT=` in .env parsed to "" and failed `.min(1)`, throwing
    // "ADO_PAT: String must contain at least 1 character(s)" on startup even in
    // azcli mode where no PAT is used.
    const cfg = loadConfig({
      ...validEnv,
      ADO_AUTH_MODE: "azcli",
      ADO_PAT: "",
      ADO_PROJECT: "",
      ADO_ORG_URL: ""
    });
    expect(cfg.azureDevOps.enabled).toBe(false);
    expect(cfg.azureDevOps.pat).toBeUndefined();
    expect(cfg.azureDevOps.project).toBeUndefined();
    expect(cfg.azureDevOps.orgUrl).toBeUndefined();
  });

  it("parses per-service proxy URLs", () => {
    const cfg = loadConfig({
      ...validEnv,
      SERVICENOW_PROXY: "http://giba-proxy.example.net:8080",
      ADO_PROXY: "http://ado-proxy.example.net:3128"
    });
    expect(cfg.serviceNow.proxyUrl).toBe("http://giba-proxy.example.net:8080");
    expect(cfg.azureDevOps.proxyUrl).toBe("http://ado-proxy.example.net:3128");
  });

  it("treats absent or empty proxy as undefined", () => {
    expect(loadConfig(validEnv).serviceNow.proxyUrl).toBeUndefined();
    expect(loadConfig({ ...validEnv, SERVICENOW_PROXY: "" }).serviceNow.proxyUrl).toBeUndefined();
  });

  it("rejects a malformed proxy URL", () => {
    expect(() => loadConfig({ ...validEnv, SERVICENOW_PROXY: "not a url" })).toThrow(/SERVICENOW_PROXY/);
  });

  it("rejects a non-http(s) proxy scheme", () => {
    expect(() => loadConfig({ ...validEnv, ADO_PROXY: "ftp://proxy.example:21" })).toThrow(/ADO_PROXY/);
  });

  it("applies threshold overrides from env", () => {
    const cfg = loadConfig({ ...validEnv, STALE_P1_MIN: "15", CORRELATION_HOURS_BEFORE: "48" });
    expect(cfg.thresholds.staleByPriorityMinutes["1"]).toBe(15);
    expect(cfg.thresholds.relatedChangeWindow.beforeHours).toBe(48);
  });
});
