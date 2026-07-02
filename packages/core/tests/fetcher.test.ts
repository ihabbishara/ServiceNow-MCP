import { describe, it, expect, vi, afterEach } from "vitest";
import { fetch } from "undici";
import type { Mock } from "vitest";
import { Fetcher } from "../src/clients/crawler/fetcher.js";

// Clients use undici's fetch (not Node's global fetch); mock that named export.
vi.mock("undici", async (orig) => {
  const actual = await orig<typeof import("undici")>();
  return { ...actual, fetch: vi.fn() };
});

afterEach(() => vi.resetAllMocks());

const fetchMock = fetch as unknown as Mock;

const res = (over: Partial<{ status: number; ct: string; body: string }>) => ({
  ok: (over.status ?? 200) < 400,
  status: over.status ?? 200,
  headers: {
    get: (h: string) => (h.toLowerCase() === "content-type" ? (over.ct ?? "text/html") : null)
  },
  text: async () => over.body ?? "<html></html>"
});

describe("Fetcher", () => {
  it("returns body for html", async () => {
    fetchMock.mockResolvedValue(res({ body: "<h1>ok</h1>" }) as any);
    const f = new Fetcher({ maxBytes: 1000 });
    const r = await f.get("https://h/p");
    expect(r.ok).toBe(true);
    expect(r.body).toContain("ok");
  });

  it("skips non-html content types", async () => {
    fetchMock.mockResolvedValue(res({ ct: "application/pdf" }) as any);
    const f = new Fetcher({ maxBytes: 1000 });
    const r = await f.get("https://h/p.pdf");
    expect(r.ok).toBe(false);
    expect(r.body).toBe("");
  });

  it("marks oversized bodies not-ok", async () => {
    fetchMock.mockResolvedValue(res({ body: "x".repeat(2000) }) as any);
    const f = new Fetcher({ maxBytes: 1000 });
    const r = await f.get("https://h/big");
    expect(r.ok).toBe(false);
  });

  describe("getText", () => {
    it("returns the body for a text/plain 200 response", async () => {
      fetchMock.mockResolvedValue(
        res({ ct: "text/plain", body: "User-agent: *\nDisallow: /x\n" }) as any
      );
      const f = new Fetcher({ maxBytes: 1000 });
      const txt = await f.getText("https://h/robots.txt");
      expect(txt).toBe("User-agent: *\nDisallow: /x\n");
    });

    it("returns '' for non-text content types", async () => {
      fetchMock.mockResolvedValue(res({ ct: "application/pdf", body: "%PDF" }) as any);
      const f = new Fetcher({ maxBytes: 1000 });
      expect(await f.getText("https://h/x.pdf")).toBe("");
    });

    it("returns '' for non-ok responses", async () => {
      fetchMock.mockResolvedValue(res({ status: 404, ct: "text/plain", body: "nope" }) as any);
      const f = new Fetcher({ maxBytes: 1000 });
      expect(await f.getText("https://h/robots.txt")).toBe("");
    });

    it("returns '' when the body exceeds maxBytes", async () => {
      fetchMock.mockResolvedValue(res({ ct: "text/plain", body: "x".repeat(2000) }) as any);
      const f = new Fetcher({ maxBytes: 1000 });
      expect(await f.getText("https://h/big.txt")).toBe("");
    });

    it("returns '' on fetch error (never throws)", async () => {
      fetchMock.mockRejectedValue(new Error("network down"));
      const f = new Fetcher({ maxBytes: 1000 });
      expect(await f.getText("https://h/robots.txt")).toBe("");
    });
  });
});
