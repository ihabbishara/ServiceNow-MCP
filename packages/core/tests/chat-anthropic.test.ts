import { describe, it, expect, vi, afterEach } from "vitest";
import * as undici from "undici";
import { AnthropicChat } from "../src/clients/chat/anthropic.js";

vi.mock("undici", async (orig) => ({ ...(await orig<typeof import("undici")>()), fetch: vi.fn() }));
const fetchMock = undici.fetch as unknown as ReturnType<typeof vi.fn>;
afterEach(() => fetchMock.mockReset());

describe("AnthropicChat", () => {
  it("posts to /v1/messages with x-api-key + anthropic-version and parses content[0].text", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ content: [{ text: "hey" }] }) } as any);
    const c = new AnthropicChat({ baseUrl: "https://api.anthropic.com", model: "claude-x", apiKey: "k" });
    expect(await c.chat("p")).toBe("hey");
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect((opts as any).headers["x-api-key"]).toBe("k");
    expect((opts as any).headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse((opts as any).body);
    expect(body.model).toBe("claude-x");
    expect(body.max_tokens).toBeGreaterThan(0);
  });

  it("throws on non-ok", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => "no" } as any);
    const c = new AnthropicChat({ baseUrl: "https://api.anthropic.com", model: "m" });
    await expect(c.chat("p")).rejects.toThrow(/401/);
  });
});
