// packages/web/tests/engine-host.test.ts
import { describe, it, expect, vi } from "vitest";
import { createEngineHost, BusyError } from "../server/engine-host.js";
import type { ServerEvent } from "../shared/events.js";

// Minimal fake ChatEngine: captures the deps the host passes, lets us drive a turn.
class FakeEngine {
  static last: FakeEngine;
  constructor(public deps: any) { FakeEngine.last = this; }
  start = vi.fn(async () => {});
  stop = vi.fn(async () => {});
  abort = vi.fn(async () => {});
  getAuthStatus = vi.fn(async () => ({ isAuthenticated: true, authType: "user", login: "me" }));
  // Simulate a turn that asks for a write confirm, then completes.
  send = vi.fn(async (_prompt: string) => {
    const approved = await this.deps.confirm("delete X?");
    this.deps.onDelta(approved ? "did it" : "skipped");
  });
}

const makeHost = (events: ServerEvent[], engineOverride?: Partial<InstanceType<typeof FakeEngine>>) =>
  createEngineHost({
    config: { llm: { mode: "seat", model: "gpt-5" } } as any,
    tools: [],
    engineFactory: (deps) => Object.assign(new FakeEngine(deps), engineOverride) as any,
    emit: (e) => events.push(e),
    idFactory: () => "fixed-id",
  });

describe("engine-host confirm round-trip", () => {
  it("emits confirm-request, blocks until resolveConfirm, then streams the result", async () => {
    const events: ServerEvent[] = [];
    const host = makeHost(events);
    await host.start();

    const turn = host.send("/triage INC123"); // workflow expansion still resolves to a prompt
    await vi.waitFor(() =>
      expect(events.some((e) => e.type === "confirm-request")).toBe(true)
    );
    host.resolveConfirm("fixed-id", true);
    await turn;

    expect(events).toContainEqual({ type: "confirm-request", id: "fixed-id", summary: "delete X?" });
    expect(events).toContainEqual({ type: "delta", text: "did it" });
    expect(events).toContainEqual({ type: "turn-end" });
  });

  it("rejects a second concurrent send with BusyError", async () => {
    const events: ServerEvent[] = [];
    const host = makeHost(events);
    await host.start();
    const first = host.send("hello");
    await expect(host.send("again")).rejects.toBeInstanceOf(BusyError);
    host.resolveConfirm("fixed-id", false);
    await first;
  });

  it("declines the write (resolves false) when the confirm times out", async () => {
    vi.useFakeTimers();
    try {
      const events: ServerEvent[] = [];
      const host = makeHost(events);
      await host.start();
      const turn = host.send("hello");
      await vi.waitFor(() => expect(events.some((e) => e.type === "confirm-request")).toBe(true));
      vi.advanceTimersByTime(5 * 60_000); // CONFIRM_TIMEOUT_MS
      await turn;
      // The fake engine streams "skipped" when the confirm resolves false.
      expect(events).toContainEqual({ type: "delta", text: "skipped" });
      expect(events).toContainEqual({ type: "turn-end" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("emits turn-error with isAuthError when the engine turn throws", async () => {
    const events: ServerEvent[] = [];
    const host = makeHost(events, {
      send: async () => { throw new Error("Authorization error, you may need to run /login"); },
    });
    await host.start();
    await host.send("hello");
    const err = events.find((e) => e.type === "turn-error");
    expect(err).toBeTruthy();
    expect((err as { isAuthError: boolean }).isAuthError).toBe(true);
  });
});

describe("engine-host snapshot", () => {
  it("snapshot() contains engine-state and auth-status after start()", async () => {
    const events: ServerEvent[] = [];
    const host = makeHost(events);
    await host.start();
    const snap = host.snapshot();
    expect(snap.some((e) => e.type === "engine-state")).toBe(true);
    expect(snap.some((e) => e.type === "auth-status")).toBe(true);
  });
});
