import {
  CopilotClient,
  type CopilotClientOptions,
  type CopilotSession,
  type GetAuthStatusResponse,
  type PermissionHandler,
  type SessionConfig,
  type Tool
} from "@github/copilot-sdk";
import type { AgentConfig } from "../config.js";
import { makePermissionHandler } from "./permissions.js";

/**
 * Translate the agent's seat-auth config into `CopilotClientOptions`.
 *
 * Without any of these, the SDK auto-detects a credential: it tries the env
 * tokens (COPILOT_GITHUB_TOKEN→GH_TOKEN→GITHUB_TOKEN) BEFORE the stored OAuth
 * the `copilot` CLI wrote — so a stray repo/Actions token in the environment is
 * sent and rejected (403 with a backend Request ID). We make auth deterministic:
 *   • `gitHubToken` — highest-priority SDK auth; it also flips `useLoggedInUser`
 *     to false, so NO ambient env token can override it.
 *   • `baseDirectory` (COPILOT_HOME) — points the SDK's bundled runtime at the
 *     same credential store the standalone CLI logged into.
 * BYOK mode authenticates via the session `provider`, so these are seat-only.
 */
export const buildClientOptions = (config: AgentConfig): CopilotClientOptions => {
  const options: CopilotClientOptions = {};
  if (config.llm.mode !== "seat") return options;
  if (config.copilot.githubToken) options.gitHubToken = config.copilot.githubToken;
  if (config.copilot.home) options.baseDirectory = config.copilot.home;
  return options;
};

export interface EngineDeps {
  config: AgentConfig;
  tools: Tool<any>[];
  /** Used by the write permission gate to ask the user before a write executes. */
  confirm: (summary: string) => Promise<boolean>;
  onDelta: (text: string) => void;
  onToolStart?: (name: string) => void;
  /**
   * Optional override for the permission handler. When omitted, the engine
   * builds one from `config.confirmWrites` + `confirm` so the write tool is
   * gated; pass an explicit handler only to bypass that wiring (e.g. tests).
   */
  onPermissionRequest?: PermissionHandler;
  /**
   * Seam for injecting the Copilot client. Defaults to
   * `(opts) => new CopilotClient(opts)` so production behavior is unchanged;
   * tests pass a fake client to assert the seat-auth options
   * (`gitHubToken`/`baseDirectory`) and the `createSession` config (seat vs
   * BYOK) without a live Copilot seat.
   */
  clientFactory?: (options: CopilotClientOptions) => CopilotClient;
}

/**
 * Front-end-agnostic chat engine wrapping the Copilot SDK lifecycle:
 * start a client, create a streaming session with our tools, stream
 * `assistant.message_delta` chunks, and resolve a turn when the session
 * goes idle. Seat auth is the default; a BYOK provider is attached only
 * when configured.
 */
export class ChatEngine {
  private client?: CopilotClient;
  private session?: CopilotSession;
  private unsubscribe: Array<() => void> = [];

  constructor(private readonly deps: EngineDeps) {}

  async start(): Promise<void> {
    // Seat auth options are derived from config; tests inject a fake factory
    // to assert what the client is constructed with.
    const clientFactory =
      this.deps.clientFactory ?? ((opts: CopilotClientOptions) => new CopilotClient(opts));
    this.client = clientFactory(buildClientOptions(this.deps.config));
    await this.client.start();

    // If anything after start() fails, stop the client so the engine stays
    // self-contained (no dangling CLI process) before rethrowing.
    try {
      const cfg = this.deps.config;
      // Gate writes through the confirm seam unless the caller supplies its own
      // handler. Built once so the write tool always prompts per config.
      const permissionHandler =
        this.deps.onPermissionRequest ??
        makePermissionHandler({ confirmWrites: cfg.confirmWrites }, this.deps.confirm);
      const sessionConfig: SessionConfig = {
        model: cfg.llm.model,
        streaming: true,
        tools: this.deps.tools,
        onPermissionRequest: permissionHandler,
        ...(cfg.llm.mode === "byok" && cfg.llm.provider
          ? {
              provider: {
                type: cfg.llm.provider.type,
                baseUrl: cfg.llm.provider.baseUrl,
                apiKey: cfg.llm.provider.apiKey,
                ...(cfg.llm.provider.type === "azure"
                  ? { azure: { apiVersion: cfg.llm.provider.apiVersion } }
                  : {})
              }
            }
          : {})
      };

      this.session = await this.client.createSession(sessionConfig);

      this.unsubscribe.push(
        this.session.on("assistant.message_delta", (e) =>
          this.deps.onDelta(e.data.deltaContent)
        )
      );
      this.unsubscribe.push(
        this.session.on("tool.execution_start", (e) =>
          this.deps.onToolStart?.(e.data.toolName)
        )
      );
    } catch (err) {
      const stopErrors = await this.client.stop().catch(() => []);
      if (stopErrors.length > 0) {
        console.error("[sre-agent] cleanup after failed start:", stopErrors);
      }
      this.client = undefined;
      throw err;
    }
  }

  /**
   * Current Copilot authentication status (login name, auth type, whether the
   * credential resolved). Used by the CLI to preflight seat auth before the
   * first turn and to drive the in-tool login flow. `authType: "env"` here is a
   * useful tell that an ambient token — not the stored OAuth — was picked up.
   */
  async getAuthStatus(): Promise<GetAuthStatusResponse> {
    if (!this.client) throw new Error("engine not started");
    return this.client.getAuthStatus();
  }

  /**
   * Send a prompt and resolve when the session goes idle (turn complete).
   * `sendAndWait` is the shipped turn-completion mechanism; streaming deltas
   * are still delivered to the `onDelta` handler while it waits.
   */
  async send(prompt: string): Promise<void> {
    if (!this.session) throw new Error("engine not started");
    await this.session.sendAndWait(prompt);
  }

  async abort(): Promise<void> {
    await this.session?.abort();
  }

  async stop(): Promise<void> {
    for (const off of this.unsubscribe.splice(0)) off();
    await this.session?.disconnect();
    const stopErrors = (await this.client?.stop()) ?? [];
    // Release the handles so post-stop calls fail loudly with "engine not
    // started" instead of dispatching into a stopped client, and so a later
    // start() (e.g. relogin) rebuilds from a clean slate.
    this.session = undefined;
    this.client = undefined;
    if (stopErrors.length > 0) {
      console.error("[sre-agent] errors during shutdown:", stopErrors);
    }
  }
}
