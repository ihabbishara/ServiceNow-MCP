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

// Minimal fake ChatEngine for ingest tests (no FakeEngine class dependency needed)
const fakeEngine = {
  start: async () => {},
  stop: async () => {},
  abort: async () => {},
  send: async () => {},
  getAuthStatus: async () => ({ isAuthenticated: true }),
} as any;

describe("EngineHost ingest", () => {
  it("ingestFile extracts then indexes, emitting status", async () => {
    const events: ServerEvent[] = [];
    const knowledge = {
      close: async () => {},
      indexDocument: vi.fn(async (_doc: any, onPhase: (p: any) => void) => {
        onPhase({ phase: "embedding", done: 0, total: 1 });
        return { indexed: true, chunks: 1 };
      }),
      crawl: vi.fn(),
      listSources: vi.fn(async () => []),
      deleteSource: vi.fn(),
    };
    const host = createEngineHost({
      config: { uploadMaxBytes: 1000 } as any,
      tools: [],
      engineFactory: () => fakeEngine,
      emit: (e) => events.push(e),
      runtimeFactory: () => ({ knowledge }) as any,
    });
    await host.ingestFile("notes.txt", Buffer.from("hello"));
    expect(knowledge.indexDocument).toHaveBeenCalledWith(
      expect.objectContaining({ key: "upload://notes.txt", title: "notes.txt", text: "hello" }),
      expect.any(Function)
    );
    expect(events.map((e) => e.type)).toContain("ingest-status");
    expect(events.some((e) => e.type === "ingest-status" && e.phase === "indexed" && e.chunks === 1)).toBe(true);
    expect(events.some((e) => e.type === "ingest-status" && e.phase === "embedding" && e.detail === "0/1")).toBe(true);
  });

  it("ingestFile emits skipped for an unsupported format", async () => {
    const events: ServerEvent[] = [];
    const knowledge = {
      close: async () => {},
      indexDocument: vi.fn(),
      crawl: vi.fn(),
      listSources: vi.fn(),
      deleteSource: vi.fn(),
    };
    const host = createEngineHost({
      config: { uploadMaxBytes: 1000 } as any,
      tools: [],
      engineFactory: () => fakeEngine,
      emit: (e) => events.push(e),
      runtimeFactory: () => ({ knowledge }) as any,
    });
    await host.ingestFile("deck.ppt", Buffer.from("x"));
    expect(knowledge.indexDocument).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === "ingest-status" && e.phase === "skipped" && e.reason === "unsupported format")).toBe(true);
  });

  it("ingestUrl crawls the single seed and emits indexed", async () => {
    const events: ServerEvent[] = [];
    const knowledge = {
      close: async () => {},
      indexDocument: vi.fn(),
      crawl: vi.fn(async () => ({ pagesCrawled: 1, pagesIndexed: 1, pagesSkipped: 0, chunksAdded: 4, dropped: 0 })),
      listSources: vi.fn(),
      deleteSource: vi.fn(),
    };
    const host = createEngineHost({
      config: { uploadMaxBytes: 1000 } as any,
      tools: [],
      engineFactory: () => fakeEngine,
      emit: (e) => events.push(e),
      runtimeFactory: () => ({ knowledge }) as any,
    });
    await host.ingestUrl("https://h/p");
    expect(knowledge.crawl).toHaveBeenCalledWith(expect.objectContaining({ seeds: ["https://h/p"], allowDomains: ["h"] }));
    expect(events.some((e) => e.type === "ingest-status" && e.phase === "indexed" && e.chunks === 4)).toBe(true);
  });

  it("ingestUrl emits skipped when crawl returns pagesCrawled:0", async () => {
    const events: ServerEvent[] = [];
    const knowledge = {
      close: async () => {},
      indexDocument: vi.fn(),
      crawl: vi.fn(async () => ({ pagesCrawled: 0, pagesIndexed: 0, pagesSkipped: 1, chunksAdded: 0, dropped: 0 })),
      listSources: vi.fn(),
      deleteSource: vi.fn(),
    };
    const host = createEngineHost({
      config: { uploadMaxBytes: 1000 } as any,
      tools: [],
      engineFactory: () => fakeEngine,
      emit: (e) => events.push(e),
      runtimeFactory: () => ({ knowledge }) as any,
    });
    await host.ingestUrl("https://example.com/page");
    const skipped = events.find((e) => e.type === "ingest-status" && e.phase === "skipped");
    expect(skipped).toBeTruthy();
    expect((skipped as any).reason).toMatch(/nothing indexed/);
  });

  it("ingestUrl emits skipped when crawl throws", async () => {
    const events: ServerEvent[] = [];
    const knowledge = {
      close: async () => {},
      indexDocument: vi.fn(),
      crawl: vi.fn(async () => { throw new Error("network failure"); }),
      listSources: vi.fn(),
      deleteSource: vi.fn(),
    };
    const host = createEngineHost({
      config: { uploadMaxBytes: 1000 } as any,
      tools: [],
      engineFactory: () => fakeEngine,
      emit: (e) => events.push(e),
      runtimeFactory: () => ({ knowledge }) as any,
    });
    await host.ingestUrl("https://example.com/page");
    const skipped = events.find((e) => e.type === "ingest-status" && e.phase === "skipped");
    expect(skipped).toBeTruthy();
    expect((skipped as any).reason).toBe("network failure");
  });

  it("ingestFile emits skipped when indexDocument throws", async () => {
    const events: ServerEvent[] = [];
    const knowledge = {
      close: async () => {},
      indexDocument: vi.fn(async () => { throw new Error("embed store error"); }),
      crawl: vi.fn(),
      listSources: vi.fn(async () => []),
      deleteSource: vi.fn(),
    };
    const host = createEngineHost({
      config: { uploadMaxBytes: 1000 } as any,
      tools: [],
      engineFactory: () => fakeEngine,
      emit: (e) => events.push(e),
      runtimeFactory: () => ({ knowledge }) as any,
    });
    await host.ingestFile("notes.txt", Buffer.from("hello"));
    const skipped = events.find((e) => e.type === "ingest-status" && e.phase === "skipped");
    expect(skipped).toBeTruthy();
    expect((skipped as any).reason).toBe("embed store error");
  });

  it("ingestFile emits skipped with 'knowledge index not configured' when runtimeFactory is omitted", async () => {
    const events: ServerEvent[] = [];
    const host = createEngineHost({
      config: { uploadMaxBytes: 1000 } as any,
      tools: [],
      engineFactory: () => fakeEngine,
      emit: (e) => events.push(e),
      // runtimeFactory intentionally omitted
    });
    await host.ingestFile("notes.txt", Buffer.from("hi"));
    expect(events.some((e) => e.type === "ingest-status" && e.phase === "skipped" && e.reason === "knowledge index not configured")).toBe(true);
  });

  it("ingestUrl emits skipped with 'knowledge index not configured' when runtimeFactory is omitted", async () => {
    const events: ServerEvent[] = [];
    const host = createEngineHost({
      config: { uploadMaxBytes: 1000 } as any,
      tools: [],
      engineFactory: () => fakeEngine,
      emit: (e) => events.push(e),
      // runtimeFactory intentionally omitted
    });
    await host.ingestUrl("https://example.com");
    expect(events.some((e) => e.type === "ingest-status" && e.phase === "skipped" && e.reason === "knowledge index not configured")).toBe(true);
  });

  it("ingestFile emits skipped with reason when indexDocument returns a skipped result", async () => {
    const events: ServerEvent[] = [];
    const knowledge = {
      close: async () => {},
      indexDocument: vi.fn(async (_doc: any, _onPhase: any) => ({
        indexed: false,
        chunks: 0,
        skipped: "no extractable text",
      })),
      crawl: vi.fn(),
      listSources: vi.fn(async () => []),
      deleteSource: vi.fn(),
    };
    const host = createEngineHost({
      config: { uploadMaxBytes: 1000 } as any,
      tools: [],
      engineFactory: () => fakeEngine,
      emit: (e) => events.push(e),
      runtimeFactory: () => ({ knowledge }) as any,
    });
    await host.ingestFile("notes.txt", Buffer.from("hello"));
    expect(events.some((e) => e.type === "ingest-status" && e.phase === "skipped" && e.reason === "no extractable text")).toBe(true);
  });
});

describe("engine-host config-status", () => {
  const fullConfig = {
    llm: { mode: "seat", model: "gpt-5" },
    adoAuthMode: "pat",
    confirmWrites: true,
    copilot: { ignoreEnvToken: true },
    raw: { SERVICENOW_BASE_URL: "https://x.service-now.com", ADO_PAT: "p" },
  } as any;

  const makeFullHost = (events: ServerEvent[]) =>
    createEngineHost({
      config: fullConfig,
      tools: [],
      engineFactory: (deps) => new FakeEngine(deps) as any,
      emit: (e) => events.push(e),
      idFactory: () => "fixed-id",
      runtimeFactory: () => ({ knowledge: { close: async () => {} } }),
    });

  it("emits config-status with config-derived flags on start()", async () => {
    const events: ServerEvent[] = [];
    const host = makeFullHost(events);
    await host.start();
    const cs = events.find((e) => e.type === "config-status");
    expect(cs).toMatchObject({
      type: "config-status",
      llmMode: "seat",
      model: "gpt-5",
      servicenow: true,
      ado: true, // pat mode + ADO_PAT present
      rag: true, // runtimeFactory provided
    });
  });

  it("includes config-status in snapshot()", async () => {
    const events: ServerEvent[] = [];
    const host = makeFullHost(events);
    await host.start();
    expect(host.snapshot().some((e) => e.type === "config-status")).toBe(true);
  });
});
