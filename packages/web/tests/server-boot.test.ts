import { describe, it, expect, afterAll } from "vitest";
import type { Server } from "node:http";
import { AddressInfo } from "node:net";
import { startServer } from "../server/index.js";

let server: Server;
afterAll(() => server?.close());

describe("startServer", () => {
  it("binds 127.0.0.1 and answers /api/health", async () => {
    server = await startServer({ port: 0 });
    const { port, address } = server.address() as AddressInfo;
    expect(address).toBe("127.0.0.1");
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
