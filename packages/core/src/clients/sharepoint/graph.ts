import { fetch } from "undici";
import { proxyDispatcher, FetchDispatcher } from "../proxy.js";
import type { GraphPort } from "./types.js";

const BASE = "https://graph.microsoft.com/v1.0";
const MAX_RETRIES = 4;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type FetchImpl = typeof fetch;

export interface GraphClientOptions {
  getToken: () => Promise<string>;
  proxyUrl?: string;
  timeoutMs?: number;
  fetchImpl?: FetchImpl;
}

/** Thin Microsoft Graph v1.0 client: bearer auth, pagination, 429 backoff, downloads. */
export class GraphClient implements GraphPort {
  private readonly getToken: () => Promise<string>;
  private readonly dispatcher?: FetchDispatcher;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchImpl;

  constructor(opts: GraphClientOptions) {
    this.getToken = opts.getToken;
    this.dispatcher = proxyDispatcher(opts.proxyUrl);
    this.timeoutMs = opts.timeoutMs ?? 30000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** absoluteOrPath: a path beginning "/" (joined to BASE) or a full nextLink URL. */
  private async request(absoluteOrPath: string, accept = "application/json"): Promise<any> {
    const url = absoluteOrPath.startsWith("http") ? absoluteOrPath : `${BASE}${absoluteOrPath}`;
    const label = absoluteOrPath.startsWith("http") ? new URL(absoluteOrPath).pathname : absoluteOrPath;
    for (let attempt = 0; ; attempt++) {
      const token = await this.getToken();
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.timeoutMs);
      let res: Awaited<ReturnType<FetchImpl>>;
      try {
        res = await this.fetchImpl(url, {
          headers: { Authorization: `Bearer ${token}`, Accept: accept },
          dispatcher: this.dispatcher,
          signal: ac.signal
        } as any);
      } finally {
        clearTimeout(timer);
      }
      if (res.status === 429 && attempt < MAX_RETRIES) {
        const retryAfter = Number(res.headers.get("retry-after") ?? "1");
        await sleep((Number.isFinite(retryAfter) ? retryAfter : 1) * 1000);
        continue;
      }
      if (!res.ok) {
        const body = (await res.text()).slice(0, 200);
        throw new Error(`Graph GET ${label} failed: ${res.status} ${body}`);
      }
      return res;
    }
  }

  async get<T>(path: string): Promise<T> {
    const res = await this.request(path);
    return (await res.json()) as T;
  }

  async getAllPages<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    const seen = new Set<string>();
    let next: string | undefined = path;
    while (next) {
      if (seen.has(next)) throw new Error(`Graph pagination loop detected at ${next}`);
      seen.add(next);
      const page = (await (await this.request(next)).json()) as { value: T[]; "@odata.nextLink"?: string };
      out.push(...(page.value ?? []));
      next = page["@odata.nextLink"];
    }
    return out;
  }

  async download(driveId: string, itemId: string, maxBytes?: number): Promise<Buffer> {
    const res = await this.request(`/drives/${driveId}/items/${itemId}/content`, "application/octet-stream");
    const cl = res.headers.get("content-length");
    if (maxBytes !== undefined && cl !== null && Number(cl) > maxBytes) {
      throw new Error(`download exceeds max bytes (${cl} > ${maxBytes})`);
    }
    const ab = await res.arrayBuffer();
    const buf = Buffer.from(ab);
    if (maxBytes !== undefined && buf.length > maxBytes) {
      throw new Error(`download exceeds max bytes (${buf.length} > ${maxBytes})`);
    }
    return buf;
  }
}
