import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { proxyDispatcher } from "../../src/clients/proxy.js";

// Real end-to-end check that the proxy dispatcher is accepted by the runtime's
// global fetch and that traffic is directed at the proxy. This is a regression
// guard for the undici-major/runtime-undici mismatch: an incompatible undici
// throws "invalid onRequestStart method" during request setup, before any
// socket is opened — this test asserts that does NOT happen (we reach the proxy
// socket) so a future undici bump that breaks compatibility fails here.

describe("proxy dispatcher (real fetch)", () => {
  let server: net.Server | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  });

  it("is accepted by global fetch and directs traffic to the proxy", async () => {
    let connections = 0;
    server = net.createServer((sock) => {
      connections += 1;
      sock.destroy(); // accept then drop → fetch fails at the socket, not at dispatcher setup
    });
    const port = await new Promise<number>((resolve) =>
      server!.listen(0, "127.0.0.1", () => resolve((server!.address() as AddressInfo).port))
    );

    const dispatcher = proxyDispatcher(`http://127.0.0.1:${port}`);
    let message = "";
    try {
      await fetch("http://servicenow.invalid/x", { dispatcher });
      throw new Error("expected fetch to fail");
    } catch (err) {
      message = (err as { cause?: { message?: string } })?.cause?.message ?? (err as Error).message;
    }

    expect(message).not.toMatch(/onRequestStart/); // dispatcher was accepted by global fetch
    expect(connections).toBeGreaterThan(0); // traffic actually went to the proxy address
  });
});
