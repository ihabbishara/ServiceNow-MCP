import { describe, it, expect, vi } from "vitest";
import { GraphClient } from "./graph.js";

const res = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  json: async () => body,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  arrayBuffer: async () => body as Buffer
});

const client = (fetchImpl: any) =>
  new GraphClient({ getToken: async () => "tok", fetchImpl, timeoutMs: 1000 });

describe("GraphClient", () => {
  it("GETs with bearer auth and returns json", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(200, { id: "s1" }));
    const out = await client(fetchImpl).get<{ id: string }>("/sites/x");
    expect(out.id).toBe("s1");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://graph.microsoft.com/v1.0/sites/x");
    expect(init.headers.Authorization).toBe("Bearer tok");
  });

  it("getAllPages follows @odata.nextLink and flattens value", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        res(200, {
          value: [{ id: "a" }],
          "@odata.nextLink": "https://graph.microsoft.com/v1.0/next"
        })
      )
      .mockResolvedValueOnce(res(200, { value: [{ id: "b" }] }));
    const out = await client(fetchImpl).getAllPages<{ id: string }>("/drives/d/root/children");
    expect(out.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("retries on 429 honoring Retry-After", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(res(429, "slow down", { "retry-after": "0" }))
      .mockResolvedValueOnce(res(200, { id: "ok" }));
    const out = await client(fetchImpl).get<{ id: string }>("/x");
    expect(out.id).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("throws after exhausting 429 retries", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(429, "busy", { "retry-after": "0" }));
    await expect(client(fetchImpl).get("/x")).rejects.toThrow(/Graph GET \/x failed: 429/);
    expect(fetchImpl).toHaveBeenCalledTimes(5); // MAX_RETRIES(4) + 1 final attempt
  });

  it("getAllPages throws on a self-referential @odata.nextLink", async () => {
    const loop = "https://graph.microsoft.com/v1.0/drives/d/root/children?page=loop";
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(res(200, { value: [{ id: "a" }], "@odata.nextLink": loop }));
    await expect(client(fetchImpl).getAllPages(loop)).rejects.toThrow(/pagination loop detected/);
  });

  it("throws with status + snippet on non-retryable error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(404, "not found"));
    await expect(client(fetchImpl).get("/missing")).rejects.toThrow(
      /Graph GET \/missing failed: 404/
    );
  });

  it("download returns a Buffer of the item content", async () => {
    const bytes = Buffer.from("hello");
    const fetchImpl = vi
      .fn()
      .mockResolvedValue({ ...res(200, ""), arrayBuffer: async () => bytes });
    const out = await client(fetchImpl).download("drive1", "item1");
    expect(Buffer.from(out).toString()).toBe("hello");
    expect(fetchImpl.mock.calls[0][0]).toBe(
      "https://graph.microsoft.com/v1.0/drives/drive1/items/item1/content"
    );
  });

  it("download rejects when content-length header exceeds maxBytes", async () => {
    const bytes = Buffer.from("hello world");
    const fetchImpl = vi.fn().mockResolvedValue({
      ...res(200, "", { "content-length": "11" }),
      arrayBuffer: async () => bytes
    });
    await expect(client(fetchImpl).download("d", "i", 5)).rejects.toThrow(/exceeds max bytes/);
  });

  it("download resolves when no maxBytes is provided even if body is large", async () => {
    const bytes = Buffer.from("hello world");
    const fetchImpl = vi.fn().mockResolvedValue({
      ...res(200, "", { "content-length": "11" }),
      arrayBuffer: async () => bytes
    });
    const out = await client(fetchImpl).download("d", "i");
    expect(Buffer.from(out).toString()).toBe("hello world");
  });
});
