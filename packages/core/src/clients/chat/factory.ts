import type { ChatModel } from "./types.js";
import { OpenAiChat } from "./openai.js";
import { AnthropicChat } from "./anthropic.js";

/** Provider config for the crawl verdict chat; derived from the agent's LLM_* env. */
export interface ChatConfig {
  type: "openai" | "azure" | "anthropic";
  baseUrl: string;
  model: string;
  apiKey?: string;
  apiVersion?: string;
}

/** Build a ChatModel from BYOK config, or undefined (seat mode → heuristic crawl). */
export const makeChatModel = (cfg?: ChatConfig, proxyUrl?: string): ChatModel | undefined => {
  if (!cfg) return undefined;
  if (cfg.type === "anthropic") {
    return new AnthropicChat({ baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey, proxyUrl });
  }
  return new OpenAiChat({
    type: cfg.type,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    apiKey: cfg.apiKey,
    apiVersion: cfg.apiVersion,
    proxyUrl
  });
};
