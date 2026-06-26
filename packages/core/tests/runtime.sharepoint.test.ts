import { describe, it, expect } from "vitest";
import { createMcpRuntime } from "../src/runtime.js";

const base = {
  SERVICENOW_BASE_URL: "https://sn.example.com",
  SERVICENOW_USERNAME: "u",
  SERVICENOW_PASSWORD: "p"
};

describe("runtime sharePoint wiring", () => {
  it("is undefined when disabled", () => {
    expect(createMcpRuntime(base).sharePoint).toBeUndefined();
  });
  it("is defined when enabled", () => {
    const rt = createMcpRuntime({
      ...base,
      SHAREPOINT_ENABLED: "true",
      SHAREPOINT_SITE_URL: "https://acme.sharepoint.com/sites/SRE"
    });
    expect(rt.sharePoint).toBeDefined();
  });
});
