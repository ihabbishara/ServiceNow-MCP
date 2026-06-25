import { describe, it, expect, afterAll, vi } from "vitest";
import type { Server } from "node:http";
import { AddressInfo } from "node:net";
import { startServer } from "../server/index.js";
import { createEngineHost } from "../server/engine-host.js";

class FakeEngine {
  constructor(public deps: any) {}
  start = vi.fn(async () => {});
  stop = vi.fn(async () => {});
  abort = vi.fn(async () => {});
  getAuthStatus = vi.fn(async () => ({ isAuthenticated: true, authType: "user", login: "me" }));
  send = vi.fn(async () => {});
}

let server: Server;
afterAll(() => server?.close());

describe("startServer", () => {
  it("binds 127.0.0.1 and answers /api/health", async () => {
    const host = createEngineHost({
      config: { llm: { mode: "seat", model: "gpt-5" }, copilot: {} } as any,
      tools: [],
      engineFactory: (d) => new FakeEngine(d) as any,
      runtimeFactory: () => ({ knowledge: { close: async () => {} } }),
    });
    await host.start();
    server = await startServer({ port: 0, host });
    const { port, address } = server.address() as AddressInfo;
    expect(address).toBe("127.0.0.1");
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
