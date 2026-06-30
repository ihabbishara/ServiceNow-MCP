import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, writeFile as writeFileRaw } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseEnv,
  parseEnvWithComments,
  serializeEnv,
  updateEnvText,
  writeEnvFile,
  readEnvFile,
  readEnvFields
} from "../server/dotenv-file.js";

describe("parseEnv", () => {
  it("parses KEY=VALUE lines, ignoring blanks and comments", () => {
    expect(parseEnv("# c\nA=1\n\nB=two words\n")).toEqual({ A: "1", B: "two words" });
  });

  it("strips a trailing inline comment after a quoted value", () => {
    expect(parseEnv('PW="s3cr#et" # ServiceNow password (SECRET)')).toEqual({ PW: "s3cr#et" });
  });

  it("strips a trailing inline comment after an unquoted value", () => {
    expect(parseEnv("MODE=azcli   # azcli or pat")).toEqual({ MODE: "azcli" });
  });

  it("keeps a # that lives inside quotes", () => {
    expect(parseEnv('K="a#b#c"')).toEqual({ K: "a#b#c" });
  });

  it("treats a value that is only a comment as empty", () => {
    expect(parseEnv("ADO_AREA_PATH= # default area path")).toEqual({ ADO_AREA_PATH: "" });
  });
});

describe("parseEnvWithComments", () => {
  it("captures the inline comment per key", () => {
    const f = parseEnvWithComments('URL=https://x # instance base URL\nPW="p" # secret (SECRET)');
    expect(f.URL).toEqual({ value: "https://x", comment: "instance base URL" });
    expect(f.PW).toEqual({ value: "p", comment: "secret (SECRET)" });
  });
});

describe("updateEnvText", () => {
  it("changes only listed values and preserves comments, order, and blank lines", () => {
    const original = "# header\nA=1 # first\n\nB=old # second\nC=keep\n";
    const out = updateEnvText(original, { B: "new" });
    expect(out).toBe("# header\nA=1 # first\n\nB=new # second\nC=keep\n");
  });

  it("appends keys that are not already present", () => {
    expect(updateEnvText("A=1\n", { A: "1", D: "two words" })).toBe('A=1\nD="two words"\n');
  });

  it("on an empty original behaves like a fresh serialize", () => {
    expect(updateEnvText("", { A: "1", B: "x y" })).toBe('A=1\nB="x y"\n');
  });
});

describe("serializeEnv", () => {
  it("emits one KEY=VALUE per line, trailing newline", () => {
    expect(serializeEnv({ A: "1", B: "x" })).toBe("A=1\nB=x\n");
  });
});

describe("round-trip", () => {
  it("writes then reads back the same map", async () => {
    const dir = await mkdtemp(join(tmpdir(), "envtest-"));
    const path = join(dir, ".env");
    await writeEnvFile(path, { FOO: "bar", BAZ: "qux quux" });
    expect(await readEnvFile(path)).toEqual({ FOO: "bar", BAZ: "qux quux" });
    expect(await readFile(path, "utf8")).toContain("FOO=bar");
  });
});

describe("writeEnvFile preserves comments", () => {
  it("edits a value in place without dropping the inline comment", async () => {
    const dir = await mkdtemp(join(tmpdir(), "envtest-"));
    const path = join(dir, ".env");
    await writeFileRaw(path, 'SERVICENOW_USERNAME=old # ServiceNow username\nADO_ENABLED=false # core PAT path\n');
    await writeEnvFile(path, { SERVICENOW_USERNAME: "NPA_T", ADO_ENABLED: "false" });
    const text = await readFile(path, "utf8");
    expect(text).toContain("SERVICENOW_USERNAME=NPA_T # ServiceNow username");
    expect(text).toContain("ADO_ENABLED=false # core PAT path");
    const { vars, comments } = await readEnvFields(path);
    expect(vars.SERVICENOW_USERNAME).toBe("NPA_T");
    expect(comments.SERVICENOW_USERNAME).toBe("ServiceNow username");
  });
});

describe("round-trip with special characters", () => {
  it("preserves spaces, #, =, quotes, and newlines through serialize->parse", () => {
    const vars = {
      SIMPLE: "value",
      SPACED: "has spaces",
      HASH: "value#withhash",
      EQUALS: "p@ss=w0rd",
      QUOTED: 'has"quote',
      MULTILINE: "line1\nline2",
      EMPTY: "",
    };
    expect(parseEnv(serializeEnv(vars))).toEqual(vars);
  });
});
