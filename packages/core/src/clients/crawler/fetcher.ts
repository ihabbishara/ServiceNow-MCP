import { fetch } from "undici";
import { proxyDispatcher, FetchDispatcher } from "../proxy.js";
import type { FetchResult } from "../../services/knowledge/types.js";

export interface FetcherOptions {
  maxBytes: number;
  proxyUrl?: string;
  timeoutMs?: number;
}

export class Fetcher {
  private readonly dispatcher?: FetchDispatcher;
  constructor(private readonly opts: FetcherOptions) {
    this.dispatcher = proxyDispatcher(opts.proxyUrl);
  }

  async get(url: string): Promise<FetchResult> {
    const empty = (status: number, ct = ""): FetchResult => ({ ok: false, status, contentType: ct, body: "" });
    try {
      const res = await fetch(url, {
        method: "GET",
        dispatcher: this.dispatcher,
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 15000),
        headers: { "user-agent": "sre-agent-crawler/1.0" }
      });
      const ct = res.headers.get("content-type") ?? "";
      if (!res.ok) return empty(res.status, ct);
      if (!ct.includes("text/html")) return empty(res.status, ct);
      const body = await res.text();
      if (body.length > this.opts.maxBytes) return empty(res.status, ct);
      return { ok: true, status: res.status, contentType: ct, body };
    } catch {
      return empty(0);
    }
  }
}
