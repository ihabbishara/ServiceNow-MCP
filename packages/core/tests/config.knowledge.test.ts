import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

const base = {
  SERVICENOW_BASE_URL: "https://x.service-now.com",
  SERVICENOW_USERNAME: "u",
  SERVICENOW_PASSWORD: "p"
};

describe("knowledge config", () => {
  it("applies defaults", () => {
    const c = loadConfig(base);
    expect(c.knowledge.maxPages).toBe(200);
    expect(c.knowledge.maxDepth).toBe(3);
    expect(c.knowledge.embedModel).toBe("nomic-embed-text");
    expect(c.knowledge.embedBaseUrl).toBe("http://localhost:11434/v1");
    expect(c.knowledge.respectRobots).toBe(true);
    expect(c.knowledge.seeds).toEqual([]);
  });

  it("parses seeds + derives allowDomains from seed hosts", () => {
    const c = loadConfig({ ...base, CRAWL_SEEDS: "https://wiki.acme.io/a, https://kb.acme.io/b" });
    expect(c.knowledge.seeds).toEqual(["https://wiki.acme.io/a", "https://kb.acme.io/b"]);
    expect(c.knowledge.allowDomains).toEqual(["wiki.acme.io", "kb.acme.io"]);
  });

  it("embedBaseUrl falls back to LLM_BASE_URL", () => {
    const c = loadConfig({ ...base, LLM_BASE_URL: "http://ollama:11434/v1" });
    expect(c.knowledge.embedBaseUrl).toBe("http://ollama:11434/v1");
  });
});
