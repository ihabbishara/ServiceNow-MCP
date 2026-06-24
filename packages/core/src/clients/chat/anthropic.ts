import { fetch } from "undici";
import { proxyDispatcher, FetchDispatcher } from "../proxy.js";
import type { ChatModel } from "./types.js";

export interface AnthropicChatOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  maxTokens?: number;
  proxyUrl?: string;
}

/** Anthropic Messages API chat client. */
export class AnthropicChat implements ChatModel {
  private readonly dispatcher?: FetchDispatcher;
  constructor(private readonly opts: AnthropicChatOptions) {
    this.dispatcher = proxyDispatcher(opts.proxyUrl);
  }

  async chat(prompt: string): Promise<string> {
    const res = await fetch(`${this.opts.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.opts.apiKey ?? "",
        "anthropic-version": "2023-06-01"
      },
      dispatcher: this.dispatcher,
      body: JSON.stringify({
        model: this.opts.model,
        max_tokens: this.opts.maxTokens ?? 1024,
        messages: [{ role: "user", content: prompt }]
      })
    });
    if (!res.ok) throw new Error(`chat failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { content?: { text?: string }[] };
    return data.content?.[0]?.text ?? "";
  }
}
