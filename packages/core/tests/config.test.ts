import { describe, it, expect } from "vitest";
import { loadConfig, buildAppConfig, envSchema } from "../src/config.js";

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
    expect(cfg.thresholds.staleByPriorityMinutes).toEqual({
      "1": 30,
      "2": 120,
      "3": 1440,
      "4": 4320
    });
    expect(cfg.thresholds.relatedChangeWindow).toEqual({ beforeHours: 24, afterHours: 4 });
  });

  it("strips trailing slash from base URL", () => {
    const cfg = loadConfig({
      ...validEnv,
      SERVICENOW_BASE_URL: "https://example.service-now.com/"
    });
    expect(cfg.serviceNow.baseUrl).toBe("https://example.service-now.com");
  });

  it("throws naming the missing required vars", () => {
    expect(() => loadConfig({})).toThrow(/SERVICENOW_BASE_URL/);
    expect(() => loadConfig({})).toThrow(/SERVICENOW_USERNAME/);
  });

  it("includes the custom 'is required' message for each missing ServiceNow var", () => {
    expect(() => loadConfig({})).toThrow(/SERVICENOW_BASE_URL is required/);
    expect(() => loadConfig({ SERVICENOW_BASE_URL: "https://sn.example.com" })).toThrow(
      /SERVICENOW_USERNAME is required/
    );
    expect(() =>
      loadConfig({ SERVICENOW_BASE_URL: "https://sn.example.com", SERVICENOW_USERNAME: "u" })
    ).toThrow(/SERVICENOW_PASSWORD is required/);
  });

  it("requires ADO vars when ADO_ENABLED=true", () => {
    expect(() => loadConfig({ ...validEnv, ADO_ENABLED: "true" })).toThrow(
      /ADO_ORG_URL and ADO_PROJECT/
    );
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
    expect(() => loadConfig({ ...validEnv, SERVICENOW_PROXY: "not a url" })).toThrow(
      /SERVICENOW_PROXY/
    );
  });

  it("rejects a non-http(s) proxy scheme", () => {
    expect(() => loadConfig({ ...validEnv, ADO_PROXY: "ftp://proxy.example:21" })).toThrow(
      /ADO_PROXY/
    );
  });

  it("applies threshold overrides from env", () => {
    const cfg = loadConfig({ ...validEnv, STALE_P1_MIN: "15", CORRELATION_HOURS_BEFORE: "48" });
    expect(cfg.thresholds.staleByPriorityMinutes["1"]).toBe(15);
    expect(cfg.thresholds.relatedChangeWindow.beforeHours).toBe(48);
  });
});

const base = {
  SERVICENOW_BASE_URL: "https://sn.example.com",
  SERVICENOW_USERNAME: "u",
  SERVICENOW_PASSWORD: "p"
};

describe("sharePoint config", () => {
  it("defaults to disabled with no env", () => {
    const cfg = loadConfig(base);
    expect(cfg.sharePoint.enabled).toBe(false);
  });

  it("requires SHAREPOINT_SITE_URL when enabled", () => {
    expect(() => loadConfig({ ...base, SHAREPOINT_ENABLED: "true" })).toThrow(
      /SHAREPOINT_ENABLED=true requires SHAREPOINT_SITE_URL/
    );
  });

  it("parses enabled config with defaults", () => {
    const cfg = loadConfig({
      ...base,
      SHAREPOINT_ENABLED: "true",
      SHAREPOINT_SITE_URL: "https://acme.sharepoint.com/sites/SRE"
    });
    expect(cfg.sharePoint).toMatchObject({
      enabled: true,
      siteUrl: "https://acme.sharepoint.com/sites/SRE",
      incidentRoot: "",
      docsSubfolder: "Docs",
      authMode: "azcli",
      maxDocTokens: 50000,
      maxFiles: 50,
      maxFileBytes: 10485760,
      timeoutMs: 30000
    });
  });
});

describe("loadConfig ADO_BOARD_MAP", () => {
  it("parses a JSON board map", () => {
    const c = loadConfig({ ...base, ADO_BOARD_MAP: '{"Team Alpha":"Platform\\\\Alpha"}' });
    expect(c.azureDevOps.boardMap).toEqual({ "Team Alpha": "Platform\\Alpha" });
  });

  it("defaults to an empty map when unset", () => {
    const c = loadConfig({ ...base });
    expect(c.azureDevOps.boardMap).toEqual({});
  });

  it("ignores invalid JSON without throwing", () => {
    const c = loadConfig({ ...base, ADO_BOARD_MAP: "{not json" });
    expect(c.azureDevOps.boardMap).toEqual({});
  });
});

describe("loadConfig ADO_CSV_DIR", () => {
  it("passes through csvDir and defaults csvMaxBytes", () => {
    const c = loadConfig({ ...base, ADO_CSV_DIR: "/data/csvs" });
    expect(c.azureDevOps.csvDir).toBe("/data/csvs");
    expect(c.azureDevOps.csvMaxBytes).toBe(5242880);
  });
  it("leaves csvDir undefined when unset", () => {
    const c = loadConfig({ ...base });
    expect(c.azureDevOps.csvDir).toBeUndefined();
  });
});

describe("parity: buildAppConfig + envSchema", () => {
  it("buildAppConfig(envSchema.parse(env)) equals loadConfig(env)", () => {
    const env = {
      ...validEnv,
      ADO_ENABLED: "true",
      ADO_ORG_URL: "https://dev.azure.com/x",
      ADO_PROJECT: "P"
    };
    const viaLoad = loadConfig(env);
    const viaBuild = buildAppConfig(envSchema.parse(env));
    expect(viaBuild).toEqual(viaLoad);
  });
});

describe("loadConfig ADO auth-mode validation", () => {
  const adoBase = {
    ...base,
    ADO_ENABLED: "true",
    ADO_ORG_URL: "https://dev.azure.com/org",
    ADO_PROJECT: "Proj"
  };
  it("allows azcli mode without a PAT", () => {
    const c = loadConfig({ ...adoBase, ADO_AUTH_MODE: "azcli" });
    expect(c.azureDevOps.enabled).toBe(true);
    expect(c.azureDevOps.pat).toBeUndefined();
  });
  it("requires a PAT in pat mode", () => {
    expect(() => loadConfig({ ...adoBase, ADO_AUTH_MODE: "pat" })).toThrow(/ADO_PAT/);
  });
  it("requires org and project when enabled", () => {
    expect(() => loadConfig({ ...base, ADO_ENABLED: "true", ADO_AUTH_MODE: "azcli" })).toThrow(
      /ADO_ORG_URL and ADO_PROJECT/
    );
  });
});
