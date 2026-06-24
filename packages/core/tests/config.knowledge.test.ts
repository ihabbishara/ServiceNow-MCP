import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

const base = {
  SERVICENOW_BASE_URL: "https://x.service-now.com",
  SERVICENOW_USERNAME: "u",
  SERVICENOW_PASSWORD: "p"
};

describe("knowledge config", () => {
  it("applies defaults (local embed model, no chat in seat mode)", () => {
    const c = loadConfig(base);
    expect(c.knowledge.maxPages).toBe(200);
    expect(c.knowledge.maxDepth).toBe(3);
    expect(c.knowledge.embedModel).toBe("Xenova/bge-small-en-v1.5");
    expect(c.knowledge.embedModelPath).toBeUndefined();
    expect(c.knowledge.respectRobots).toBe(true);
    expect(c.knowledge.seeds).toEqual([]);
    expect(c.knowledge.chat).toBeUndefined(); // seat default → heuristic crawl
  });

  it("parses seeds + derives allowDomains from seed hosts", () => {
    const c = loadConfig({ ...base, CRAWL_SEEDS: "https://wiki.acme.io/a, https://kb.acme.io/b" });
    expect(c.knowledge.seeds).toEqual(["https://wiki.acme.io/a", "https://kb.acme.io/b"]);
    expect(c.knowledge.allowDomains).toEqual(["wiki.acme.io", "kb.acme.io"]);
  });

  it("byok → knowledge.chat derived from LLM_* env", () => {
    const c = loadConfig({
      ...base,
      LLM_MODE: "byok",
      LLM_PROVIDER: "azure",
      LLM_BASE_URL: "https://r.openai.azure.com",
      LLM_API_KEY: "secret",
      LLM_MODEL: "dep1",
      AZURE_API_VERSION: "2024-10-21"
    });
    expect(c.knowledge.chat).toEqual({
      type: "azure",
      baseUrl: "https://r.openai.azure.com",
      apiKey: "secret",
      model: "dep1",
      apiVersion: "2024-10-21"
    });
  });

  it("byok without provider/base-url → chat undefined (no half-config)", () => {
    const c = loadConfig({ ...base, LLM_MODE: "byok" });
    expect(c.knowledge.chat).toBeUndefined();
  });

  it("EMBED_MODEL_PATH carried through", () => {
    const c = loadConfig({ ...base, EMBED_MODEL_PATH: "/opt/models/bge" });
    expect(c.knowledge.embedModelPath).toBe("/opt/models/bge");
  });
});
