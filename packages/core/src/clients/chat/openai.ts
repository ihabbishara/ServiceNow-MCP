import { fetch } from "undici";
import { proxyDispatcher, FetchDispatcher } from "../proxy.js";
import type { ChatModel } from "./types.js";

export interface OpenAiChatOptions {
  type: "openai" | "azure";
  baseUrl: string;
  model: string;
  apiKey?: string;
  apiVersion?: string; // azure only
  proxyUrl?: string;
}

/** OpenAI-compatible chat (also serves Azure OpenAI and self-hosted OpenAI-compatible endpoints). */
export class OpenAiChat implements ChatModel {
  private readonly dispatcher?: FetchDispatcher;
  constructor(private readonly opts: OpenAiChatOptions) {
    this.dispatcher = proxyDispatcher(opts.proxyUrl);
  }

  private url(): string {
    if (this.opts.type === "azure") {
      const v = this.opts.apiVersion ?? "2024-10-21";
      return `${this.opts.baseUrl}/openai/deployments/${this.opts.model}/chat/completions?api-version=${v}`;
    }
    return `${this.opts.baseUrl}/chat/completions`;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.opts.apiKey) {
      if (this.opts.type === "azure") h["api-key"] = this.opts.apiKey;
      else h.authorization = `Bearer ${this.opts.apiKey}`;
    }
    return h;
  }

  async chat(prompt: string): Promise<string> {
    const res = await fetch(this.url(), {
      method: "POST",
      headers: this.headers(),
      dispatcher: this.dispatcher,
      body: JSON.stringify({
        model: this.opts.model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
        stream: false
      })
    });
    if (!res.ok) throw new Error(`chat failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? "";
  }
}
