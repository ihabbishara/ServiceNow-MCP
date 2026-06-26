import { describe, it, expect, vi } from "vitest";
import type { SessionConfig } from "@github/copilot-sdk";
import { ChatEngine, buildClientOptions, KNOWLEDGE_SYSTEM_INSTRUCTION } from "../src/engine/engine.js";
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
const makeFakeClient = (
  authStatus = { isAuthenticated: true, login: "octocat", authType: "user" as const }
) => {
  const session = makeFakeSession();
  const createSession = vi.fn(async (_config: SessionConfig) => session);
  const getAuthStatus = vi.fn(async () => authStatus);
  const client = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => [] as Error[]),
    getAuthStatus,
    createSession
  };
  return { client, createSession, getAuthStatus, session };
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

  it("appends the knowledge system message when CRAWL_SEEDS is set (seat or byok)", async () => {
    const { client, createSession } = makeFakeClient();
    const config = loadAgentConfig({ ...base, CRAWL_SEEDS: "https://wiki.acme.io/a" });
    const engine = new ChatEngine({ config, tools: [], ...noopDeps, clientFactory: () => client as never });
    await engine.start();
    const sessionConfig = createSession.mock.calls[0][0];
    expect(sessionConfig.systemMessage).toEqual({
      mode: "append",
      content: KNOWLEDGE_SYSTEM_INSTRUCTION
    });
    expect(KNOWLEDGE_SYSTEM_INSTRUCTION).toContain("search_knowledge");
  });

  it("omits systemMessage when the crawler is not configured", async () => {
    const { client, createSession } = makeFakeClient();
    const config = loadAgentConfig({ ...base }); // no CRAWL_SEEDS
    const engine = new ChatEngine({ config, tools: [], ...noopDeps, clientFactory: () => client as never });
    await engine.start();
    const sessionConfig = createSession.mock.calls[0][0];
    expect("systemMessage" in sessionConfig).toBe(false);
  });
});

describe("ChatEngine Copilot client auth options", () => {
  const startWithConfig = async (env: Record<string, string>) => {
    const { client } = makeFakeClient();
    let opts: Record<string, unknown> | undefined;
    const config = loadAgentConfig(env);
    const engine = new ChatEngine({
      config,
      tools: [],
      ...noopDeps,
      clientFactory: (o: unknown) => {
        opts = o as Record<string, unknown>;
        return client as never;
      }
    });
    await engine.start();
    return opts ?? {};
  };

  it("seat mode without Copilot vars: no gitHubToken / baseDirectory passed", async () => {
    const opts = await startWithConfig({ ...base });
    expect(opts.gitHubToken).toBeUndefined();
    expect(opts.baseDirectory).toBeUndefined();
  });

  it("COPILOT_GITHUB_TOKEN flows to the client as gitHubToken (priority auth)", async () => {
    const opts = await startWithConfig({ ...base, COPILOT_GITHUB_TOKEN: "gho_seat" });
    expect(opts.gitHubToken).toBe("gho_seat");
  });

  it("COPILOT_HOME flows to the client as baseDirectory (the CLI's store)", async () => {
    const opts = await startWithConfig({ ...base, COPILOT_HOME: "/home/me/.copilot" });
    expect(opts.baseDirectory).toBe("/home/me/.copilot");
  });
});

describe("buildClientOptions ambient-token stripping", () => {
  const poisonedEnv = {
    PATH: "/usr/bin",
    GH_TOKEN: "ghp_repo",
    GITHUB_TOKEN: "ghp_actions",
    COPILOT_GITHUB_TOKEN: "stale"
  } as NodeJS.ProcessEnv;

  it("seat, no explicit token: strips GH_TOKEN/GITHUB_TOKEN/COPILOT_GITHUB_TOKEN from the runtime env", () => {
    const opts = buildClientOptions(loadAgentConfig({ ...base }), poisonedEnv);
    expect(opts.gitHubToken).toBeUndefined();
    expect(opts.env).toBeDefined();
    expect(opts.env?.GH_TOKEN).toBeUndefined();
    expect(opts.env?.GITHUB_TOKEN).toBeUndefined();
    expect(opts.env?.COPILOT_GITHUB_TOKEN).toBeUndefined();
    // Everything else is preserved so the runtime still finds PATH, etc.
    expect(opts.env?.PATH).toBe("/usr/bin");
  });

  it("explicit COPILOT_GITHUB_TOKEN wins and does NOT strip the env", () => {
    const opts = buildClientOptions(
      loadAgentConfig({ ...base, COPILOT_GITHUB_TOKEN: "gho_explicit" }),
      poisonedEnv
    );
    expect(opts.gitHubToken).toBe("gho_explicit");
    expect(opts.env).toBeUndefined();
  });

  it("COPILOT_IGNORE_ENV_TOKEN=false leaves ambient tokens in place (opt-out)", () => {
    const opts = buildClientOptions(
      loadAgentConfig({ ...base, COPILOT_IGNORE_ENV_TOKEN: "false" }),
      poisonedEnv
    );
    expect(opts.env).toBeUndefined();
  });

  it("byok mode: no client auth options and no env stripping", () => {
    const opts = buildClientOptions(
      loadAgentConfig({
        ...base,
        LLM_MODE: "byok",
        LLM_PROVIDER: "azure",
        LLM_BASE_URL: "https://x.openai.azure.com"
      }),
      poisonedEnv
    );
    expect(opts.gitHubToken).toBeUndefined();
    expect(opts.env).toBeUndefined();
  });
});

describe("ChatEngine.getAuthStatus", () => {
  it("delegates to the client's getAuthStatus after start", async () => {
    const { client, getAuthStatus } = makeFakeClient({
      isAuthenticated: false,
      login: "octocat",
      authType: "env" as const
    });
    const config = loadAgentConfig({ ...base });
    const engine = new ChatEngine({
      config,
      tools: [],
      ...noopDeps,
      clientFactory: () => client as never
    });
    await engine.start();

    const status = await engine.getAuthStatus();
    expect(getAuthStatus).toHaveBeenCalledOnce();
    expect(status.isAuthenticated).toBe(false);
    expect(status.authType).toBe("env");
  });

  it("throws when called before start (no client)", async () => {
    const config = loadAgentConfig({ ...base });
    const engine = new ChatEngine({ config, tools: [], ...noopDeps });
    await expect(engine.getAuthStatus()).rejects.toThrow(/not started/);
  });

  it("reverts to a not-started state after stop (no calls into a stopped client)", async () => {
    const { client } = makeFakeClient();
    const config = loadAgentConfig({ ...base });
    const engine = new ChatEngine({
      config,
      tools: [],
      ...noopDeps,
      clientFactory: () => client as never
    });
    await engine.start();
    await engine.stop();
    // After stop the client/session are released; calling in must fail loudly
    // rather than dispatch to a stopped client.
    await expect(engine.getAuthStatus()).rejects.toThrow(/not started/);
  });
});
