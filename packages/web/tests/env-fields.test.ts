import { describe, it, expect } from "vitest";
import { envSchema } from "@sre/core";
import {
  groupOf,
  isSecret,
  labelOf,
  describe as describeField,
  ENV_FIELDS,
  visibleKeys,
  varsToSave
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

describe("catalog completeness (drift guard)", () => {
  const AGENT_ONLY_KEYS = [
    "WEB_PORT",
    "COPILOT_CLI_PATH",
    "TURN_TIMEOUT_MS",
    "CONFIRM_WRITES",
    "COPILOT_GITHUB_TOKEN",
    "COPILOT_HOME",
    "COPILOT_IGNORE_ENV_TOKEN",
    "CRAWL_TTL_HOURS",
    "UPLOAD_MAX_BYTES"
  ];
  for (const key of [...Object.keys(envSchema.shape), ...AGENT_ONLY_KEYS]) {
    it(`catalogs ${key}`, () => {
      expect(ENV_FIELDS[key], key).toBeDefined();
      expect(ENV_FIELDS[key].description.length).toBeGreaterThan(10);
    });
  }

  it("puts GIT_WORKSPACE_DIR in the Azure DevOps group", () => {
    expect(ENV_FIELDS.GIT_WORKSPACE_DIR.group).toBe("Azure DevOps");
    expect(ENV_FIELDS.GIT_WORKSPACE_DIR.description).toMatch(/temp dir/i);
  });
});

describe("visibleKeys", () => {
  it("returns catalog keys for a group even when the file has none", () => {
    const keys = visibleKeys("Azure DevOps", []);
    expect(keys).toContain("GIT_WORKSPACE_DIR");
    expect(keys).toContain("ADO_ORG_URL");
  });

  it("orders catalog keys first (declaration order), file-only extras after", () => {
    const keys = visibleKeys("Other", ["MY_CUSTOM_FLAG"]);
    expect(keys.at(-1)).toBe("MY_CUSTOM_FLAG");
    expect(keys.indexOf("CONFIRM_WRITES")).toBeLessThan(keys.indexOf("MY_CUSTOM_FLAG"));
  });

  it("does not duplicate a cataloged key that is also in the file", () => {
    const keys = visibleKeys("Azure DevOps", ["ADO_ORG_URL"]);
    expect(keys.filter((k) => k === "ADO_ORG_URL")).toHaveLength(1);
  });

  it("does not leak uncataloged file keys into non-Other groups", () => {
    expect(visibleKeys("ServiceNow", ["MY_CUSTOM_FLAG"])).not.toContain("MY_CUSTOM_FLAG");
  });
});

describe("varsToSave", () => {
  it("drops empty values for keys not originally in the file", () => {
    expect(varsToSave({ GIT_WORKSPACE_DIR: "", ADO_PROJECT: "IngOne" }, ["ADO_PROJECT"])).toEqual({
      ADO_PROJECT: "IngOne"
    });
  });

  it("keeps an emptied value for a key the user is clearing (originally present)", () => {
    expect(varsToSave({ ADO_PAT: "" }, ["ADO_PAT"])).toEqual({ ADO_PAT: "" });
  });

  it("keeps all non-empty values regardless of origin", () => {
    expect(varsToSave({ GIT_WORKSPACE_DIR: "/var/tmp/repos" }, [])).toEqual({
      GIT_WORKSPACE_DIR: "/var/tmp/repos"
    });
  });
});
