// packages/web/tests/routes.test.ts
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
  send = vi.fn(async () => this.deps.onDelta("hello"));
}

const servers: Server[] = [];
afterAll(() => servers.forEach((s) => s.close()));

const boot = async () => {
  const host = createEngineHost({
    config: { llm: { mode: "seat", model: "gpt-5" }, copilot: {} } as any,
    tools: [],
    engineFactory: (d) => new FakeEngine(d) as any,
    runtimeFactory: () => ({ knowledge: { close: async () => {} } }),
  });
  await host.start();
  const server = await startServer({ port: 0, host });
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
};

describe("routes", () => {
  it("streams a delta over SSE after POST /api/chat", async () => {
    const base = await boot();
    // The ": connected\n\n" comment flushes headers so fetch resolves immediately.
    const es = await fetch(`${base}/api/stream`);
    const reader = es.body!.getReader();

    // Collect chunks until we find the delta event (skip the ": connected" preamble).
    const collectUntilDelta = async (): Promise<string> => {
      const chunks: string[] = [];
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(new TextDecoder().decode(value));
        if (chunks.join("").includes('"type":"delta"')) break;
      }
      return chunks.join("");
    };

    const textPromise = collectUntilDelta();
    await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hi" }),
    });
    const text = await textPromise;
    expect(text).toContain(`"type":"delta"`);
    expect(text).toContain("hello");
    await reader.cancel();
  });

  it("PUT /api/env with invalid config returns 400", async () => {
    const base = await boot();
    const res = await fetch(`${base}/api/env`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ vars: { LLM_MODE: "nonsense" } }),
    });
    expect(res.status).toBe(400);
  });
});
