import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { copilotLogin, isCopilotAuthError, type SpawnFn } from "../src/engine/auth.js";

/**
 * A fake child process: an EventEmitter exposing just the `on` surface the
 * login helper subscribes to. `emit("close", code)` / `emit("error", err)`
 * drive the two terminal outcomes the helper resolves/rejects on.
 */
const makeFakeChild = () => new EventEmitter();

const baseOpts = {
  resolveBin: () => "/bundled/@github/copilot/npm-loader.js",
  execPath: "/usr/bin/node",
  env: {} as NodeJS.ProcessEnv
};

describe("copilotLogin", () => {
  it("spawns the bundled copilot launcher with the `login` subcommand over inherited stdio", async () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn(() => child) as unknown as SpawnFn;

    const p = copilotLogin({ ...baseOpts, spawnFn });
    child.emit("close", 0);
    await p;

    expect(spawnFn).toHaveBeenCalledOnce();
    const [cmd, args, opts] = (spawnFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(cmd).toBe("/usr/bin/node");
    expect(args).toEqual(["/bundled/@github/copilot/npm-loader.js", "login"]);
    expect(opts.stdio).toBe("inherit");
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
