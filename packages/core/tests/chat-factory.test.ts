import { describe, it, expect } from "vitest";
import { makeChatModel } from "../src/clients/chat/factory.js";
import { OpenAiChat } from "../src/clients/chat/openai.js";
import { AnthropicChat } from "../src/clients/chat/anthropic.js";

describe("makeChatModel", () => {
  it("returns undefined when no config (seat mode)", () => {
    expect(makeChatModel(undefined)).toBeUndefined();
  });
  it("openai/azure -> OpenAiChat", () => {
    expect(makeChatModel({ type: "openai", baseUrl: "u", model: "m" })).toBeInstanceOf(OpenAiChat);
    expect(makeChatModel({ type: "azure", baseUrl: "u", model: "m", apiVersion: "v" })).toBeInstanceOf(OpenAiChat);
  });
  it("anthropic -> AnthropicChat", () => {
    expect(makeChatModel({ type: "anthropic", baseUrl: "u", model: "m" })).toBeInstanceOf(AnthropicChat);
  });
});
