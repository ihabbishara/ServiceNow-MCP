import { describe, it, expect, vi } from "vitest";
import { join } from "node:path";
import { resolveDotenvPath, loadDotenv } from "../src/config/env.js";

const pkgEnv = "/repo/packages/sre-agent/.env";
const home = "/home/me";
const cwd = "/work";

// A fake existsSync that only "sees" the given set of paths.
const onlyExists = (...present: string[]) => (p: string) => present.includes(p);

describe("resolveDotenvPath", () => {
  it("prefers $SRE_AGENT_ENV when that file exists", () => {
    const path = resolveDotenvPath({
      env: { SRE_AGENT_ENV: "/custom/.env" },
      exists: onlyExists("/custom/.env", join(cwd, ".env"), pkgEnv),
      home,
      cwd,
      packageEnvPath: pkgEnv
    });
    expect(path).toBe("/custom/.env");
  });

  it("skips $SRE_AGENT_ENV when that file is missing and falls back to cwd/.env", () => {
    const path = resolveDotenvPath({
      env: { SRE_AGENT_ENV: "/custom/.env" },
      exists: onlyExists(join(cwd, ".env"), pkgEnv),
      home,
      cwd,
      packageEnvPath: pkgEnv
    });
    expect(path).toBe(join(cwd, ".env"));
  });

  it("falls back to the package .env when neither override nor cwd/.env exist", () => {
    const path = resolveDotenvPath({
      env: {},
      exists: onlyExists(pkgEnv),
      home,
      cwd,
      packageEnvPath: pkgEnv
    });
    expect(path).toBe(pkgEnv);
  });

  it("falls back to ~/.sre-agent/.env last", () => {
    const homeEnv = join(home, ".sre-agent", ".env");
    const path = resolveDotenvPath({
      env: {},
      exists: onlyExists(homeEnv),
      home,
      cwd,
      packageEnvPath: pkgEnv
    });
    expect(path).toBe(homeEnv);
  });

  it("returns undefined when no candidate exists (env may be set externally)", () => {
    const path = resolveDotenvPath({
      env: {},
      exists: () => false,
      home,
      cwd,
      packageEnvPath: pkgEnv
    });
    expect(path).toBeUndefined();
  });
});

describe("loadDotenv", () => {
  it("loads the resolved file and returns its path", () => {
    const load = vi.fn();
    const path = loadDotenv({
      env: {},
      exists: onlyExists(pkgEnv),
      home,
      cwd,
      packageEnvPath: pkgEnv,
      load
    });
    expect(load).toHaveBeenCalledWith(pkgEnv);
    expect(path).toBe(pkgEnv);
  });

  it("does not load anything when no file is found", () => {
    const load = vi.fn();
    const path = loadDotenv({ env: {}, exists: () => false, home, cwd, packageEnvPath: pkgEnv, load });
    expect(load).not.toHaveBeenCalled();
    expect(path).toBeUndefined();
  });
});
