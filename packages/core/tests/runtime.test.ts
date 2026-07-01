import { describe, it, expect } from "vitest";
import { createMcpRuntime } from "../src/runtime.js";

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
});
