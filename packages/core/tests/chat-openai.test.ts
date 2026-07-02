import { describe, it, expect, vi, afterEach } from "vitest";
import * as undici from "undici";
import { OpenAiChat } from "../src/clients/chat/openai.js";

vi.mock("undici", async (orig) => ({ ...(await orig<typeof import("undici")>()), fetch: vi.fn() }));
const fetchMock = undici.fetch as unknown as ReturnType<typeof vi.fn>;
afterEach(() => fetchMock.mockReset());

const ok = (content: string) => ({
  ok: true,
  json: async () => ({ choices: [{ message: { content } }] })
});

describe("OpenAiChat", () => {
  it("openai: posts to /chat/completions with Bearer auth", async () => {
    fetchMock.mockResolvedValue(ok("hi") as any);
    const c = new OpenAiChat({
      type: "openai",
      baseUrl: "https://api.x/v1",
      model: "gpt-4o",
      apiKey: "k"
    });
    expect(await c.chat("p")).toBe("hi");
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.x/v1/chat/completions");
    expect((opts as any).headers.authorization).toBe("Bearer k");
    expect(JSON.parse((opts as any).body).model).toBe("gpt-4o");
  });

  it("azure: deployment URL + api-version + api-key header", async () => {
    fetchMock.mockResolvedValue(ok("yo") as any);
    const c = new OpenAiChat({
      type: "azure",
      baseUrl: "https://r.openai.azure.com",
      model: "dep1",
      apiKey: "k",
      apiVersion: "2024-10-21"
    });
    await c.chat("p");
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(
      "https://r.openai.azure.com/openai/deployments/dep1/chat/completions?api-version=2024-10-21"
    );
    expect((opts as any).headers["api-key"]).toBe("k");
  });

  it("throws on non-ok", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => "boom" } as any);
    const c = new OpenAiChat({ type: "openai", baseUrl: "https://api.x/v1", model: "m" });
    await expect(c.chat("p")).rejects.toThrow(/500/);
  });
});
