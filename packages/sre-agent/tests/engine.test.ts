import { describe, it, expect, vi } from "vitest";
import type { SessionConfig } from "@github/copilot-sdk";
import {
  ChatEngine,
  buildClientOptions,
  KNOWLEDGE_SYSTEM_INSTRUCTION
} from "../src/engine/engine.js";
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
 * the engine touches: `.on` (registers a handler, returns an unsubscribe fn),
 * `.sendAndWait` (fires any queued `toolEvents` through the registered
 * `tool.execution_start` handler, then either rejects with `rejectWith` or
 * emits the queued deltas through the `assistant.message_delta` handler),
 * `.disconnect`, `.abort`.
 */
const makeFakeSession = (
  deltas: string[] = [],
  opts: {
    toolEvents?: { toolName: string; arguments?: Record<string, unknown> }[];
    rejectWith?: Error;
  } = {}
) => {
  const handlers: Record<string, (e: { data: any }) => void> = {};
  const session = {
    on: vi.fn((event: string, cb: (e: { data: any }) => void) => {
      handlers[event] = cb;
      return vi.fn();
    }),
    sendAndWait: vi.fn(async () => {
      for (const t of opts.toolEvents ?? []) {
        handlers["tool.execution_start"]?.({
          data: { toolName: t.toolName, arguments: t.arguments }
        });
      }
      if (opts.rejectWith) throw opts.rejectWith;
      for (const d of deltas) handlers["assistant.message_delta"]?.({ data: { deltaContent: d } });
      return undefined;
    }),
    disconnect: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined)
  };
  return session;
};

/**
 * A fake `CopilotClient` whose `createSession` captures the `SessionConfig`
 * the engine hands it, so tests can assert seat-vs-BYOK wiring without a live
 * Copilot seat. Each `createSession` returns a NEW session: the first is the
 * main chat (no deltas); later ones are sub-agent sessions that stream
 * `subAgentDeltas` and replay `subAgentOpts` (tool events / a rejection).
 * `start`/`stop` are no-op stubs.
 */
const makeFakeClient = (
  authStatus = { isAuthenticated: true, login: "octocat", authType: "user" as const },
  subAgentDeltas: string[] = [],
  subAgentOpts: {
    toolEvents?: { toolName: string; arguments?: Record<string, unknown> }[];
    rejectWith?: Error;
  } = {}
) => {
  const sessions: ReturnType<typeof makeFakeSession>[] = [];
  const createSession = vi.fn(async (_config: SessionConfig) => {
    const s =
      sessions.length === 0 ? makeFakeSession() : makeFakeSession(subAgentDeltas, subAgentOpts);
    sessions.push(s);
    return s;
  });
  const getAuthStatus = vi.fn(async () => authStatus);
  const client = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => [] as Error[]),
    getAuthStatus,
    createSession
  };
  return { client, createSession, getAuthStatus, sessions };
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
    expect(sessionConfig.provider?.baseUrl).toBe("https://my-azure-openai.openai.azure.com");
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
    const engine = new ChatEngine({
      config,
      tools: [],
      ...noopDeps,
      clientFactory: () => client as never
    });
    await engine.start();
    const sessionConfig = createSession.mock.calls[0][0];
    // base also configures ADO, so the code-analysis instruction is appended too;
    // assert the knowledge instruction is present rather than an exact-equal match.
    expect(sessionConfig.systemMessage?.mode).toBe("append");
    expect(sessionConfig.systemMessage?.content).toContain(KNOWLEDGE_SYSTEM_INSTRUCTION);
    expect(KNOWLEDGE_SYSTEM_INSTRUCTION).toContain("search_knowledge");
  });

  it("omits systemMessage when no steering instruction applies", async () => {
    const { client, createSession } = makeFakeClient();
    // no CRAWL_SEEDS, and drop ADO so the code-analysis instruction is off too.
    const noAdo = { ...base } as Record<string, string>;
    delete noAdo.ADO_ORG_URL;
    delete noAdo.ADO_PROJECT;
    const config = loadAgentConfig(noAdo);
    const engine = new ChatEngine({
      config,
      tools: [],
      ...noopDeps,
      clientFactory: () => client as never
    });
    await engine.start();
    const sessionConfig = createSession.mock.calls[0][0];
    expect("systemMessage" in sessionConfig).toBe(false);
  });

  it("send() passes the configured TURN_TIMEOUT_MS to sendAndWait (not the SDK 60s default)", async () => {
    const { client, sessions } = makeFakeClient();
    const config = loadAgentConfig({ ...base, TURN_TIMEOUT_MS: "300000" });
    const engine = new ChatEngine({
      config,
      tools: [],
      ...noopDeps,
      clientFactory: () => client as never
    });
    await engine.start();
    await engine.send("Provide me the latest 5 incidents");
    expect(sessions[0].sendAndWait).toHaveBeenCalledWith(
      "Provide me the latest 5 incidents",
      300000
    );
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

describe("ChatEngine.runSubAgent", () => {
  it("creates a second session with ONLY the given tools, returns accumulated deltas, disconnects", async () => {
    const { client, createSession, sessions } = makeFakeClient(undefined, [
      "## Suspects\n",
      "- a.ts:42"
    ]);
    const config = loadAgentConfig({ ...base });
    const engine = new ChatEngine({
      config,
      tools: [],
      ...noopDeps,
      clientFactory: () => client as never
    });
    await engine.start();

    const subTools = [{ name: "checkout_repo" }, { name: "get_incident" }] as never[];
    const report = await engine.runSubAgent({ tools: subTools, prompt: "analyse this" });

    expect(report).toBe("## Suspects\n- a.ts:42");
    expect(createSession).toHaveBeenCalledTimes(2);
    const subConfig = createSession.mock.calls[1][0];
    expect(subConfig.tools).toBe(subTools);
    expect(subConfig.model).toBe(config.llm.model);
    expect(sessions[1].sendAndWait).toHaveBeenCalledWith("analyse this", config.turnTimeoutMs);
    expect(sessions[1].disconnect).toHaveBeenCalledOnce();
    expect(sessions[0].disconnect).not.toHaveBeenCalled(); // main session untouched
  });

  it("throws before start()", async () => {
    const config = loadAgentConfig({ ...base });
    const engine = new ChatEngine({ config, tools: [], ...noopDeps });
    await expect(engine.runSubAgent({ tools: [], prompt: "x" })).rejects.toThrow(/not started/);
  });

  it("disconnects the sub-session even when sendAndWait rejects", async () => {
    // Deterministic variant of the brief's timing-based test (see report): the
    // sub-session's sendAndWait rejects, and we assert disconnect still runs.
    const { client, sessions } = makeFakeClient(undefined, [], {
      rejectWith: new Error("timeout")
    });
    const config = loadAgentConfig({ ...base });
    const engine = new ChatEngine({
      config,
      tools: [],
      ...noopDeps,
      clientFactory: () => client as never
    });
    await engine.start();
    await expect(engine.runSubAgent({ tools: [], prompt: "x" })).rejects.toThrow(/timeout/);
    expect(sessions[1].disconnect).toHaveBeenCalledOnce();
  });
});

describe("runSubAgent onSubAgent events", () => {
  const run = async (opts: {
    deltas?: string[];
    toolEvents?: { toolName: string; arguments?: Record<string, unknown> }[];
    rejectWith?: Error;
    agentLabel?: string;
  }) => {
    const { client } = makeFakeClient(undefined, opts.deltas ?? ["ok"], {
      toolEvents: opts.toolEvents,
      rejectWith: opts.rejectWith
    });
    const config = loadAgentConfig({ ...base });
    const events: import("../src/engine/engine.js").SubAgentEvent[] = [];
    const onToolStart = vi.fn();
    const engine = new ChatEngine({
      config,
      tools: [],
      ...noopDeps,
      onToolStart,
      onSubAgent: (e) => events.push(e),
      clientFactory: () => client as never
    });
    await engine.start();
    const result = engine.runSubAgent({
      tools: [],
      prompt: "x",
      ...(opts.agentLabel ? { agentLabel: opts.agentLabel } : {})
    });
    return { result, events, onToolStart };
  };

  it("emits start → tool (with arg summary) → done, labeled", async () => {
    const { result, events } = await run({
      agentLabel: "Code Analyser",
      toolEvents: [
        { toolName: "checkout_repo", arguments: { repo_url: "https://dev.azure.com/o/p/_git/r" } },
        { toolName: "search_repo", arguments: { pattern: "PaymentError", repo_url: "https://x" } }
      ]
    });
    await result;
    expect(events.map((e) => e.phase)).toEqual(["start", "tool", "tool", "done"]);
    expect(events.every((e) => e.agent === "Code Analyser")).toBe(true);
    expect(events[1].detail).toBe("checkout_repo"); // repo_url never echoed
    expect(events[2].detail).toBe('search_repo — "PaymentError"');
    expect(events[3].detail).toMatch(/^\d+s$/);
  });

  it("defaults the label to 'sub-agent'", async () => {
    const { result, events } = await run({});
    await result;
    expect(events[0]).toMatchObject({ phase: "start", agent: "sub-agent" });
  });

  it("truncates long args to 60 chars and strips newlines", async () => {
    const long = "a".repeat(80) + "\nsecond line";
    const { result, events } = await run({
      toolEvents: [{ toolName: "search_repo", arguments: { pattern: long } }]
    });
    await result;
    const detail = events[1].detail!;
    expect(detail).toContain("search_repo — ");
    expect(detail).not.toContain("\n");
    expect(detail.length).toBeLessThanOrEqual("search_repo — ".length + 64);
    expect(detail).toContain("…");
  });

  it("emits error (then rethrows) when the sub-agent fails", async () => {
    const { result, events } = await run({
      rejectWith: new Error("timeout waiting for session.idle")
    });
    await expect(result).rejects.toThrow(/timeout/);
    expect(events.map((e) => e.phase)).toEqual(["start", "error"]);
    expect(events.at(-1)).toMatchObject({
      phase: "error",
      detail: expect.stringContaining("timeout")
    });
  });

  it("does NOT forward sub-agent tool starts to onToolStart", async () => {
    const { result, onToolStart } = await run({ toolEvents: [{ toolName: "search_repo" }] });
    await result;
    expect(onToolStart).not.toHaveBeenCalled();
  });

  it("is silent and safe when onSubAgent is not provided", async () => {
    const { client } = makeFakeClient(undefined, ["ok"], {
      toolEvents: [{ toolName: "search_repo" }]
    });
    const config = loadAgentConfig({ ...base });
    const engine = new ChatEngine({
      config,
      tools: [],
      ...noopDeps,
      clientFactory: () => client as never
    });
    await engine.start();
    await expect(engine.runSubAgent({ tools: [], prompt: "x" })).resolves.toBe("ok");
  });
});

describe("CODE_ANALYSIS_SYSTEM_INSTRUCTION", () => {
  it("is appended when ADO org is configured", async () => {
    const { client, createSession } = makeFakeClient();
    const config = loadAgentConfig({ ...base }); // base includes ADO_ORG_URL
    const engine = new ChatEngine({
      config,
      tools: [],
      ...noopDeps,
      clientFactory: () => client as never
    });
    await engine.start();
    const sc = createSession.mock.calls[0][0];
    expect(sc.systemMessage?.content).toContain("analyze_code");
    expect(sc.systemMessage?.content).toContain("_git/");
    expect(sc.systemMessage?.content).toContain("signalsDetected");
    expect(sc.systemMessage?.content).toContain("Never run the analysis without");
  });

  it("is absent when ADO org is not configured", async () => {
    const { client, createSession } = makeFakeClient();
    const noAdo = { ...base } as Record<string, string>;
    delete noAdo.ADO_ORG_URL;
    delete noAdo.ADO_PROJECT;
    const config = loadAgentConfig(noAdo);
    const engine = new ChatEngine({
      config,
      tools: [],
      ...noopDeps,
      clientFactory: () => client as never
    });
    await engine.start();
    const sc = createSession.mock.calls[0][0];
    expect(sc.systemMessage?.content ?? "").not.toContain("analyze_code");
  });
});
