// packages/web/tests/routes.test.ts
import { describe, it, expect, afterAll, vi } from "vitest";
import type { Server } from "node:http";
import { AddressInfo } from "node:net";
import { startServer } from "../server/index.js";
import { createEngineHost } from "../server/engine-host.js";
import { FakeEngine } from "./fake-engine.js";
import { handleLogin } from "../server/routes/auth.js";
import type { EngineHost } from "../server/engine-host.js";

const servers: Server[] = [];
afterAll(() => servers.forEach((s) => s.close()));

const boot = async () => {
  const host = createEngineHost({
    config: { llm: { mode: "seat", model: "gpt-5" }, copilot: {} } as any,
    tools: [],
    engineFactory: (d) => new FakeEngine(d, (deps) => deps.onDelta("hello")) as any,
    runtimeFactory: () => ({ knowledge: { close: async () => {} } })
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
      body: JSON.stringify({ prompt: "hi" })
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
      body: JSON.stringify({ vars: { LLM_MODE: "nonsense" } })
    });
    expect(res.status).toBe(400);
  });
});

describe("handleLogin error propagation (fix #11)", () => {
  it("emits turn-error when host.login() rejects", async () => {
    const emitted: unknown[] = [];
    const fakeHost: Partial<EngineHost> = {
      login: vi.fn().mockRejectedValue(new Error("device flow failed")),
      emit: vi.fn((e) => emitted.push(e))
    };
    const req = {} as never;
    const res = { writeHead: vi.fn(), end: vi.fn(), setHeader: vi.fn() } as never;
    await handleLogin(req, res, fakeHost as EngineHost);
    // login() rejection is async; flush the microtask queue
    await new Promise((r) => setTimeout(r, 0));
    expect(emitted).toContainEqual({
      type: "turn-error",
      message: "device flow failed",
      isAuthError: true
    });
  });
});

import {
  handleUpload,
  handleAddUrl,
  handleListSources,
  handleDeleteSource
} from "../server/routes/knowledge.js";

// Build a fake IncomingMessage that yields `body` bytes and carries headers.
const reqOf = (headers: Record<string, string>, body = Buffer.from("")) => {
  async function* gen() {
    yield body;
  }
  return Object.assign(gen(), { headers });
};
const resOf = () => {
  const r: any = {
    statusCode: 0,
    body: "",
    writeHead: (s: number) => {
      r.statusCode = s;
    },
    end: (b?: string) => {
      r.body = b ?? "";
    }
  };
  return r;
};
const hostOf = () =>
  ({
    uploadMaxBytes: 1000,
    ingestFile: vi.fn(async () => {}),
    ingestUrl: vi.fn(async () => {}),
    listSources: vi.fn(async () => [
      { url: "upload://a", title: "a", crawledAt: 1, indexed: true, chunkCount: 2 }
    ]),
    deleteSource: vi.fn(async () => {})
  }) as any;

describe("knowledge routes", () => {
  it("upload accepts a supported file and calls ingestFile", async () => {
    const host = hostOf();
    const res = resOf();
    await handleUpload(
      reqOf({ "x-filename": "notes.txt" }, Buffer.from("hi")),
      res,
      host,
      host.uploadMaxBytes
    );
    expect(res.statusCode).toBe(202);
    expect(host.ingestFile).toHaveBeenCalledWith("notes.txt", expect.any(Buffer));
  });

  it("upload rejects an unsupported format with 415", async () => {
    const host = hostOf();
    const res = resOf();
    await handleUpload(
      reqOf({ "x-filename": "deck.ppt" }, Buffer.from("x")),
      res,
      host,
      host.uploadMaxBytes
    );
    expect(res.statusCode).toBe(415);
    expect(host.ingestFile).not.toHaveBeenCalled();
  });

  it("upload rejects oversize with 413", async () => {
    const host = hostOf();
    const res = resOf();
    await handleUpload(
      reqOf({ "x-filename": "a.txt" }, Buffer.alloc(2000)),
      res,
      host,
      host.uploadMaxBytes
    );
    expect(res.statusCode).toBe(413);
    expect(host.ingestFile).not.toHaveBeenCalled();
  });

  it("url add validates and calls ingestUrl", async () => {
    const host = hostOf();
    const res = resOf();
    await handleAddUrl(reqOf({}, Buffer.from(JSON.stringify({ url: "https://h/p" }))), res, host);
    expect(res.statusCode).toBe(202);
    expect(host.ingestUrl).toHaveBeenCalledWith("https://h/p");
  });

  it("url add rejects an invalid url with 400", async () => {
    const host = hostOf();
    const res = resOf();
    await handleAddUrl(reqOf({}, Buffer.from(JSON.stringify({ url: "not a url" }))), res, host);
    expect(res.statusCode).toBe(400);
    expect(host.ingestUrl).not.toHaveBeenCalled();
  });

  it("list returns sources", async () => {
    const host = hostOf();
    const res = resOf();
    await handleListSources(reqOf({}), res, host);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).sources).toHaveLength(1);
  });

  it("delete calls deleteSource", async () => {
    const host = hostOf();
    const res = resOf();
    await handleDeleteSource(
      reqOf({}, Buffer.from(JSON.stringify({ url: "upload://a" }))),
      res,
      host
    );
    expect(res.statusCode).toBe(200);
    expect(host.deleteSource).toHaveBeenCalledWith("upload://a");
  });

  it("delete with missing url returns 400 and does not call deleteSource", async () => {
    const host = hostOf();
    const res = resOf();
    await handleDeleteSource(reqOf({}, Buffer.from(JSON.stringify({}))), res, host);
    expect(res.statusCode).toBe(400);
    expect(host.deleteSource).not.toHaveBeenCalled();
  });

  it("upload rejects missing X-Filename with 400", async () => {
    const host = hostOf();
    const res = resOf();
    await handleUpload(reqOf({}), res, host, host.uploadMaxBytes);
    expect(res.statusCode).toBe(400);
    expect(host.ingestFile).not.toHaveBeenCalled();
  });

  it("upload rejects a malformed X-Filename with 400", async () => {
    const host = hostOf();
    const res = resOf();
    await handleUpload(
      reqOf({ "x-filename": "file%GG.txt" }, Buffer.from("x")),
      res,
      host,
      host.uploadMaxBytes
    );
    expect(res.statusCode).toBe(400);
    expect(host.ingestFile).not.toHaveBeenCalled();
  });

  it("add-url with a malformed JSON body returns 400, not 500", async () => {
    const host = hostOf();
    const res = resOf();
    await handleAddUrl(reqOf({}, Buffer.from("{not json")), res, host);
    expect(res.statusCode).toBe(400);
    expect(host.ingestUrl).not.toHaveBeenCalled();
  });

  it("delete with a malformed JSON body returns 400, not 500", async () => {
    const host = hostOf();
    const res = resOf();
    await handleDeleteSource(reqOf({}, Buffer.from("{not json")), res, host);
    expect(res.statusCode).toBe(400);
    expect(host.deleteSource).not.toHaveBeenCalled();
  });
});
