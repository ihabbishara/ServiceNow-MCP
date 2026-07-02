// packages/web/tests/engine-host-lifecycle.test.ts
import { describe, it, expect, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEngineHost } from "../server/engine-host.js";
import type { ServerEvent } from "../shared/events.js";

class FakeEngine {
  constructor(public deps: any) {}
  start = vi.fn(async () => {});
  stop = vi.fn(async () => {});
  abort = vi.fn(async () => {});
  send = vi.fn(async () => {});
  getAuthStatus = vi.fn(async () => ({ isAuthenticated: true, authType: "user", login: "me" }));
}

const baseConfig = { llm: { mode: "seat", model: "gpt-5" }, copilot: {} } as any;

describe("engine-host login", () => {
  it("runs copilotLogin, forwards the device code as an SSE event, then restarts", async () => {
    const events: ServerEvent[] = [];
    const loginFn = vi.fn(async (o: any) => {
      o.onDeviceCode({ verificationUri: "https://github.com/login/device", userCode: "WDJB-MJHT" });
    });
    const host = createEngineHost({
      config: baseConfig,
      tools: [],
      engineFactory: (d) => new FakeEngine(d) as any,
      runtimeFactory: () => ({ knowledge: { close: async () => {} } }),
      loginFn: loginFn as any,
      emit: (e) => events.push(e)
    });
    await host.start();
    await host.login();
    expect(loginFn).toHaveBeenCalledOnce();
    expect(events).toContainEqual({
      type: "device-code",
      verificationUri: "https://github.com/login/device",
      userCode: "WDJB-MJHT"
    });
  });
});

describe("engine-host restart gate", () => {
  it("releases the turn gate after a restart interrupts an in-flight turn", async () => {
    let releaseTurn: () => void = () => {};
    const blocking = new Promise<void>((r) => {
      releaseTurn = r;
    });
    const events: ServerEvent[] = [];
    const host = createEngineHost({
      config: baseConfig,
      tools: [],
      engineFactory: (d) => {
        const e = new FakeEngine(d) as any;
        e.send = async () => {
          await blocking;
        };
        e.abort = vi.fn(async () => {
          releaseTurn();
        });
        return e;
      },
      runtimeFactory: () => ({ knowledge: { close: async () => {} } }),
      loginFn: (async (o: any) => {
        o.onDeviceCode?.({ verificationUri: "u", userCode: "C" });
      }) as any,
      emit: (e) => events.push(e)
    });
    await host.start();
    // kick off a turn that will block until abort is called
    void host.send("hello");
    await Promise.resolve();
    expect(host.isTurnRunning()).toBe(true);
    // login calls restart() which aborts the in-flight turn and resets the gate
    await host.login();
    expect(host.isTurnRunning()).toBe(false);
    // a new send should succeed without throwing BusyError
    await host.send("again");
  });
});

describe("engine-host applyEnv", () => {
  it("rejects invalid config without restarting", async () => {
    const dir = await mkdtemp(join(tmpdir(), "host-"));
    const events: ServerEvent[] = [];
    const loadConfig = vi.fn(() => {
      throw new Error("Invalid configuration:\n  SERVICENOW_BASE_URL: Required");
    });
    const host = createEngineHost({
      config: baseConfig,
      tools: [],
      engineFactory: (d) => new FakeEngine(d) as any,
      runtimeFactory: () => ({ knowledge: { close: async () => {} } }),
      loadConfig: loadConfig as any,
      envPath: join(dir, ".env"),
      emit: (e) => events.push(e)
    });
    await host.start();
    const result = await host.applyEnv({ FOO: "bar" });
    expect(result).toEqual({ ok: false, issues: expect.stringContaining("SERVICENOW_BASE_URL") });
  });
});
