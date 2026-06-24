import { describe, it, expect } from "vitest";
import { parseVerdict, buildVerdictPrompt } from "../src/services/knowledge/verdict.js";

describe("parseVerdict", () => {
  it("parses clean json", () => {
    expect(parseVerdict('{"relevant":true,"keepLinks":["https://h/a"]}')).toEqual({
      relevant: true, keepLinks: ["https://h/a"]
    });
  });
  it("extracts json embedded in prose / fences", () => {
    const v = parseVerdict('Sure!\n```json\n{"relevant": false, "keepLinks": []}\n```');
    expect(v.relevant).toBe(false);
    expect(v.keepLinks).toEqual([]);
  });
  it("defaults to keep on unparseable output (fail-soft)", () => {
    const v = parseVerdict("the model rambled with no json");
    expect(v.relevant).toBe(true);
    expect(v.keepLinks).toEqual([]);
  });
});

describe("buildVerdictPrompt", () => {
  it("includes topic, title and capped links", () => {
    const p = buildVerdictPrompt("incident runbooks", "T", "body text", ["https://h/a", "https://h/b"], 1);
    expect(p).toContain("incident runbooks");
    expect(p).toContain("https://h/a");
    expect(p).not.toContain("https://h/b"); // capped to 1
  });
});
