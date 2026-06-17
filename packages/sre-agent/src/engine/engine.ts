import {
  CopilotClient,
  type CopilotSession,
  type PermissionHandler,
  type SessionConfig,
  type Tool
} from "@github/copilot-sdk";
import type { AgentConfig } from "../config.js";

export interface EngineDeps {
  config: AgentConfig;
  tools: Tool<any>[];
  /** Used by the permission gate (Task 2.6); accepted as a seam here. */
  confirm: (summary: string) => Promise<boolean>;
  onDelta: (text: string) => void;
  onToolStart?: (name: string) => void;
  /** Optional permission handler; when omitted requests are left pending. */
  onPermissionRequest?: PermissionHandler;
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
    this.client = new CopilotClient(); // seat auth auto-detected
    await this.client.start();

    // If anything after start() fails, stop the client so the engine stays
    // self-contained (no dangling CLI process) before rethrowing.
    try {
      const cfg = this.deps.config;
      const sessionConfig: SessionConfig = {
        model: cfg.llm.model,
        streaming: true,
        tools: this.deps.tools,
        ...(this.deps.onPermissionRequest
          ? { onPermissionRequest: this.deps.onPermissionRequest }
          : {}),
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
