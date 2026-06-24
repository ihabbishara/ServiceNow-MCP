import { describe, it, expect, vi, afterEach } from "vitest";
import { fetch } from "undici";
import type { Mock } from "vitest";
import { OllamaClient } from "../src/clients/llm.js";

// Clients use undici's fetch (not Node's global fetch); mock that named export.
vi.mock("undici", async (orig) => {
  const actual = await orig<typeof import("undici")>();
  return { ...actual, fetch: vi.fn() };
});

afterEach(() => vi.resetAllMocks());

const fetchMock = fetch as unknown as Mock;

describe("OllamaClient", () => {
  it("chat posts to /chat/completions and returns content", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "hello" } }] })
    } as any);
    const c = new OllamaClient({ baseUrl: "http://h/v1", chatModel: "m", embedModel: "e" });
    const out = await c.chat("hi");
    expect(out).toBe("hello");
    expect(fetchMock.mock.calls[0][0]).toBe("http://h/v1/chat/completions");
  });

  it("embed posts to /embeddings and returns the vector", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] })
    } as any);
    const c = new OllamaClient({ baseUrl: "http://h/v1", chatModel: "m", embedModel: "e" });
    expect(await c.embed("x")).toEqual([0.1, 0.2, 0.3]);
  });

  it("throws on non-ok response", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => "boom" } as any);
    const c = new OllamaClient({ baseUrl: "http://h/v1", chatModel: "m", embedModel: "e" });
    await expect(c.chat("hi")).rejects.toThrow(/500/);
  });
});
