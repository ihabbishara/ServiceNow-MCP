import {
  CopilotClient,
  type CopilotSession,
  type PermissionHandler,
  type SessionConfig,
  type Tool
} from "@github/copilot-sdk";
import type { AgentConfig } from "../config.js";
import { makePermissionHandler } from "./permissions.js";

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
   * Seam for injecting the Copilot client. Defaults to `() => new CopilotClient()`
   * so production behavior is unchanged; tests pass a fake client to assert the
   * `createSession` config (seat vs BYOK) without a live Copilot seat.
   */
  clientFactory?: () => CopilotClient;
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
    // Seat auth is auto-detected by the default factory; tests inject a fake.
    const clientFactory = this.deps.clientFactory ?? (() => new CopilotClient());
    this.client = clientFactory();
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
    if (stopErrors.length > 0) {
      console.error("[sre-agent] errors during shutdown:", stopErrors);
    }
  }
}
