import { describe, it, expect, vi } from "vitest";
import type { SessionConfig } from "@github/copilot-sdk";
import { ChatEngine } from "../src/engine/engine.js";
import { loadAgentConfig } from "../src/config.js";

const base = {
  SERVICENOW_BASE_URL: "https://x.service-now.com",
  SERVICENOW_USERNAME: "u",
  SERVICENOW_PASSWORD: "p",
  ADO_ORG_URL: "https://dev.azure.com/INGCDaaS",
  ADO_PROJECT: "IngOne"
};

/**
 * A fake `CopilotSession` that records nothing but offers the lifecycle hooks
 * the engine touches: `.on` (returns an unsubscribe fn), `.sendAndWait`,
 * `.disconnect`, `.abort`.
 */
const makeFakeSession = () => ({
  on: vi.fn(() => vi.fn()),
  sendAndWait: vi.fn(async () => undefined),
  disconnect: vi.fn(async () => undefined),
  abort: vi.fn(async () => undefined)
});

/**
 * A fake `CopilotClient` whose `createSession` captures the `SessionConfig`
 * the engine hands it, so tests can assert seat-vs-BYOK wiring without a live
 * Copilot seat. `start`/`stop` are no-op stubs.
 */
const makeFakeClient = () => {
  const session = makeFakeSession();
  const createSession = vi.fn(async (_config: SessionConfig) => session);
  const client = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => [] as Error[]),
    createSession
  };
  return { client, createSession, session };
};

const noopDeps = {
  confirm: async () => true,
  onDelta: () => {},
  onToolStart: () => {}
};

describe("ChatEngine clientFactory seam", () => {
  it("seat mode: createSession gets the model and NO provider block", async () => {
    const { client, createSession } = makeFakeClient();
    const config = loadAgentConfig({ ...base }); // LLM_MODE unset → seat

    const engine = new ChatEngine({
      config,
      tools: [],
      ...noopDeps,
      clientFactory: () => client as never
    });
    await engine.start();

    expect(client.start).toHaveBeenCalledOnce();
    expect(createSession).toHaveBeenCalledOnce();
    const sessionConfig = createSession.mock.calls[0][0];
    expect(sessionConfig.model).toBe("gpt-5");
    expect(sessionConfig.streaming).toBe(true);
    expect("provider" in sessionConfig).toBe(false);
  });

  it("BYOK azure: createSession config includes provider.type 'azure', the model, and azure.apiVersion nesting", async () => {
    const { client, createSession } = makeFakeClient();
    const config = loadAgentConfig({
      ...base,
      LLM_MODE: "byok",
      LLM_PROVIDER: "azure",
      LLM_MODEL: "gpt-4o",
      LLM_BASE_URL: "https://my-azure-openai.openai.azure.com",
      LLM_API_KEY: "secret-key",
      AZURE_API_VERSION: "2025-01-01"
    });

    const engine = new ChatEngine({
      config,
      tools: [],
      ...noopDeps,
      clientFactory: () => client as never
    });
    await engine.start();

    const sessionConfig = createSession.mock.calls[0][0];
    expect(sessionConfig.model).toBe("gpt-4o");
    expect(sessionConfig.provider).toBeDefined();
    expect(sessionConfig.provider?.type).toBe("azure");
    expect(sessionConfig.provider?.baseUrl).toBe(
      "https://my-azure-openai.openai.azure.com"
    );
    expect(sessionConfig.provider?.apiKey).toBe("secret-key");
    expect(sessionConfig.provider?.azure).toEqual({ apiVersion: "2025-01-01" });
  });

  it("defaults clientFactory to a real CopilotClient when not injected", () => {
    // Constructing without a factory must not throw; the default seam is wired.
    const config = loadAgentConfig({ ...base });
    const engine = new ChatEngine({ config, tools: [], ...noopDeps });
    expect(engine).toBeInstanceOf(ChatEngine);
  });
});
