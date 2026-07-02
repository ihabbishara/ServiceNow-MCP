import { describe, it, expect } from "vitest";
import {
  groupOf,
  isSecret,
  labelOf,
  describe as describeField
} from "../client/src/views/env-fields.js";

describe("env-fields registry", () => {
  it("groups known keys and falls back to Other", () => {
    expect(groupOf("SERVICENOW_BASE_URL")).toBe("ServiceNow");
    expect(groupOf("CRAWL_SEEDS")).toBe("Knowledge & Crawl");
    expect(groupOf("TOTALLY_UNKNOWN_KEY")).toBe("Other");
  });

  it("flags secrets via the registry", () => {
    expect(isSecret("SERVICENOW_PASSWORD")).toBe(true);
    expect(isSecret("ADO_PAT")).toBe(true);
    expect(isSecret("LLM_API_KEY")).toBe(true);
    expect(isSecret("COPILOT_GITHUB_TOKEN")).toBe(true);
    expect(isSecret("SERVICENOW_BASE_URL")).toBe(false);
  });

  it("the secret heuristic is per-segment, so PATH keys are not secret", () => {
    expect(isSecret("AZ_PATH")).toBe(false);
    expect(isSecret("ADO_AREA_PATH")).toBe(false);
    expect(isSecret("KNOWLEDGE_DB_PATH")).toBe(false);
    // an unknown but secret-looking key still trips the heuristic
    expect(isSecret("SOME_NEW_SECRET")).toBe(true);
  });

  it("describe uses the registry, then the .env comment, then empty", () => {
    expect(describeField("SERVICENOW_PASSWORD")).toMatch(/password/i);
    expect(describeField("UNKNOWN_KEY", "inline help")).toBe("inline help");
    expect(describeField("UNKNOWN_KEY")).toBe("");
  });

  it("labelOf returns the friendly label or the raw key", () => {
    expect(labelOf("SERVICENOW_BASE_URL")).toBe("Instance URL");
    expect(labelOf("UNKNOWN_KEY")).toBe("UNKNOWN_KEY");
  });
});
