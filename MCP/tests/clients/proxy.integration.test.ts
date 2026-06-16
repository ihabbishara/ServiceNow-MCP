import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";
import { fetch } from "undici";
import { proxyDispatcher } from "../../src/clients/proxy.js";

// Real end-to-end check of the production proxy path: an HTTPS origin reached
// through an HTTP proxy via a CONNECT tunnel (what ServiceNow/ADO actually use).
// Uses undici's real fetch + our proxyDispatcher (no mocks). The local proxy
// records the CONNECT request and refuses it, so the TLS handshake never
// completes — but receiving the CONNECT for the right host:443 proves our
// dispatcher routed an HTTPS request through the proxy as a tunnel.
//
// Note: the original cross-major bug (global fetch vs package ProxyAgent) is
// designed out — this test drives undici's own fetch with undici's own
// ProxyAgent, so both are always the same major. The /onRequestStart/ guard
// below therefore protects the fetch↔dispatcher contract within the pinned
// undici (e.g. a future bad bump), not the historical global-fetch mismatch.

describe("proxy dispatcher (real CONNECT tunnel)", () => {
  let proxy: http.Server | undefined;

  afterEach(async () => {
    if (proxy) await new Promise<void>((r) => proxy!.close(() => r()));
    proxy = undefined;
  });

  it("routes an HTTPS request through the proxy via CONNECT", async () => {
    const connectTargets: string[] = [];
    proxy = http.createServer();
    proxy.on("connect", (req, socket: Socket) => {
      connectTargets.push(req.url ?? "");
      // Refuse the tunnel definitively so undici errors immediately (no retry/hang).
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    });
    const port = await new Promise<number>((resolve) =>
      proxy!.listen(0, "127.0.0.1", () => resolve((proxy!.address() as AddressInfo).port))
    );

    const dispatcher = proxyDispatcher(`http://127.0.0.1:${port}`);
    let message = "";
    try {
      await fetch("https://servicenow.invalid/api/now/table/incident", { dispatcher });
      throw new Error("expected fetch to fail (proxy drops the tunnel)");
    } catch (err) {
      message = (err as { cause?: { message?: string } })?.cause?.message ?? (err as Error).message;
    }

    expect(message).not.toMatch(/onRequestStart/); // dispatcher accepted by undici fetch
    expect(connectTargets).toContain("servicenow.invalid:443"); // CONNECT tunnel to the right origin
  }, 15000);
});
