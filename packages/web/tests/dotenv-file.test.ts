import { describe, it, expect } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv, serializeEnv, writeEnvFile, readEnvFile } from "../server/dotenv-file.js";

describe("parseEnv", () => {
  it("parses KEY=VALUE lines, ignoring blanks and comments", () => {
    expect(parseEnv("# c\nA=1\n\nB=two words\n")).toEqual({ A: "1", B: "two words" });
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
