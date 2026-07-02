import { describe, it, expect } from "vitest";
import { createMcpRuntime } from "../src/runtime.js";
import { loadConfig } from "../src/config.js";

const env = {
  SERVICENOW_BASE_URL: "https://sn.example.com",
  SERVICENOW_USERNAME: "u",
  SERVICENOW_PASSWORD: "p"
};

describe("createMcpRuntime", () => {
  it("exposes a workItemService", () => {
    const rt = createMcpRuntime(env);
    expect(rt.workItemService).toBeDefined();
    expect(typeof rt.workItemService.create).toBe("function");
    expect(typeof rt.workItemService.clone).toBe("function");
  });

  it("accepts a prebuilt AppConfig without re-reading env", () => {
    const cfg = loadConfig(env);
    const rt = createMcpRuntime(cfg);
    expect(rt.config).toBe(cfg); // same object identity → no re-parse
  });
});
