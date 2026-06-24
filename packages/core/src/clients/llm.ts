import { fetch } from "undici";
import { proxyDispatcher, FetchDispatcher } from "./proxy.js";
import type { LlmClient } from "../services/knowledge/types.js";

export interface OllamaOptions {
  baseUrl: string; // includes /v1
  chatModel: string;
  embedModel: string;
  apiKey?: string; // optional; Ollama ignores it
  proxyUrl?: string;
}

/**
 * Minimal OpenAI-compatible client for the crawl pipeline. Talks directly to
 * the Ollama endpoint (NOT through the Copilot SDK) because crawl/CLI ingest
 * runs outside any Copilot session.
 */
export class OllamaClient implements LlmClient {
  private readonly dispatcher?: FetchDispatcher;
  constructor(private readonly opts: OllamaOptions) {
    this.dispatcher = proxyDispatcher(opts.proxyUrl);
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.opts.apiKey) h.authorization = `Bearer ${this.opts.apiKey}`;
    return h;
  }

  async chat(prompt: string): Promise<string> {
    const res = await fetch(`${this.opts.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      dispatcher: this.dispatcher,
      body: JSON.stringify({
        model: this.opts.chatModel,
        messages: [{ role: "user", content: prompt }],
        stream: false,
        temperature: 0
      })
    });
    if (!res.ok) throw new Error(`chat failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? "";
  }

  async embed(text: string): Promise<number[]> {
    const res = await fetch(`${this.opts.baseUrl}/embeddings`, {
      method: "POST",
      headers: this.headers(),
      dispatcher: this.dispatcher,
      body: JSON.stringify({ model: this.opts.embedModel, input: text })
    });
    if (!res.ok) throw new Error(`embed failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { data?: { embedding?: number[] }[] };
    const vec = data.data?.[0]?.embedding;
    if (!vec) throw new Error("embed failed: no embedding in response");
    return vec;
  }
}
