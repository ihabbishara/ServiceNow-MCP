import { describe, it, expect } from "vitest";
import { createMcpRuntime } from "../src/runtime.js";

const env = {
  SERVICENOW_BASE_URL: "https://x.service-now.com",
  SERVICENOW_USERNAME: "u",
  SERVICENOW_PASSWORD: "p"
};

describe("runtime.knowledge", () => {
  it("exposes a KnowledgeService", () => {
    const rt = createMcpRuntime(env);
    expect(rt.knowledge).toBeDefined();
    expect(typeof rt.knowledge.search).toBe("function");
    expect(typeof rt.knowledge.crawl).toBe("function");
  });
});
