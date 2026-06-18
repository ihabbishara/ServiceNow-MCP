import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  copilotLogin,
  isCopilotAuthError,
  resolveSdkRuntime,
  type SpawnFn
} from "../src/engine/auth.js";

/**
 * A fake child process: an EventEmitter exposing just the `on` surface the
 * login helper subscribes to. `emit("close", code)` / `emit("error", err)`
 * drive the two terminal outcomes the helper resolves/rejects on.
 */
const makeFakeChild = () => new EventEmitter();

// The login path mirrors the SDK runtime: the pure-JS index.js, run via node.
const indexJs = "/bundled/@github/copilot/index.js";
const baseOpts = {
  resolveBin: () => indexJs,
  execPath: "/usr/bin/node",
  env: {} as NodeJS.ProcessEnv
};

describe("copilotLogin", () => {
  it("runs the bundled index.js runtime via node with the `login` subcommand over inherited stdio", async () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn(() => child) as unknown as SpawnFn;

    const p = copilotLogin({ ...baseOpts, spawnFn });
    child.emit("close", 0);
    await p;

    expect(spawnFn).toHaveBeenCalledOnce();
    const [cmd, args, opts] = (spawnFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(cmd).toBe("/usr/bin/node");
    expect(args).toEqual([indexJs, "login"]);
    expect(opts.stdio).toBe("inherit");
  });

  it("runs a native (non-.js) runtime path directly, without prefixing node", async () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn(() => child) as unknown as SpawnFn;
    const nativeBin = "/bundled/@github/copilot-win32-x64/copilot.exe";

    const p = copilotLogin({ ...baseOpts, resolveBin: () => nativeBin, spawnFn });
    child.emit("close", 0);
    await p;

    const [cmd, args] = (spawnFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(cmd).toBe(nativeBin);
    expect(args).toEqual(["login"]);
  });

  it("sets COPILOT_HOME in the child env so login writes the store the SDK reads", async () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn(() => child) as unknown as SpawnFn;

    const p = copilotLogin({ ...baseOpts, spawnFn, home: "/home/me/.copilot" });
    child.emit("close", 0);
    await p;

    const opts = (spawnFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(opts.env.COPILOT_HOME).toBe("/home/me/.copilot");
  });

  it("does not set COPILOT_HOME when no home is given (runtime default ~/.copilot)", async () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn(() => child) as unknown as SpawnFn;

    const p = copilotLogin({ ...baseOpts, spawnFn });
    child.emit("close", 0);
    await p;

    const opts = (spawnFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect("COPILOT_HOME" in opts.env).toBe(false);
  });

  it("rejects when the login process exits non-zero", async () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn(() => child) as unknown as SpawnFn;

    const p = copilotLogin({ ...baseOpts, spawnFn });
    child.emit("close", 1);
    await expect(p).rejects.toThrow(/exit/i);
  });

  it("rejects when the process fails to spawn", async () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn(() => child) as unknown as SpawnFn;

    const p = copilotLogin({ ...baseOpts, spawnFn });
    child.emit("error", new Error("ENOENT"));
    await expect(p).rejects.toThrow(/ENOENT/);
  });
});

describe("resolveSdkRuntime", () => {
  it("resolves the SAME bundled @github/copilot index.js the SDK spawns (not npm-loader)", () => {
    const bin = resolveSdkRuntime();
    // The SDK runs the pure-JS runtime; logging in through any other entry
    // (e.g. npm-loader.js, which prefers the native binary and gates on Node
    // v24) could write a different store than the SDK reads.
    expect(bin.endsWith(join("@github", "copilot", "index.js"))).toBe(true);
    expect(bin).not.toContain("npm-loader");
    expect(existsSync(bin)).toBe(true);
  });

  it("honors COPILOT_CLI_PATH so login follows any SDK runtime override", () => {
    const prev = process.env.COPILOT_CLI_PATH;
    process.env.COPILOT_CLI_PATH = "/custom/copilot/index.js";
    try {
      expect(resolveSdkRuntime()).toBe("/custom/copilot/index.js");
    } finally {
      if (prev === undefined) delete process.env.COPILOT_CLI_PATH;
      else process.env.COPILOT_CLI_PATH = prev;
    }
  });
});

describe("isCopilotAuthError", () => {
  it("matches the SDK's authorization-error turn failure", () => {
    expect(
      isCopilotAuthError(
        new Error("Authorization error, you may need to run /login (Request ID: abc-123)")
      )
    ).toBe(true);
  });

  it("matches bare 401/403 transport errors", () => {
    expect(isCopilotAuthError(new Error("Request failed with status 403"))).toBe(true);
    expect(isCopilotAuthError(new Error("401 Unauthorized"))).toBe(true);
  });

  it("does not match unrelated failures", () => {
    expect(isCopilotAuthError(new Error("ServiceNow 500 internal error"))).toBe(false);
    expect(isCopilotAuthError(new Error("sendAndWait timed out"))).toBe(false);
  });

  it("tolerates non-Error values", () => {
    expect(isCopilotAuthError("Authorization error")).toBe(true);
    expect(isCopilotAuthError(undefined)).toBe(false);
  });
});
