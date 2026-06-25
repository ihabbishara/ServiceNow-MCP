// packages/web/server/engine-host.ts
import type { ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import {
  ChatEngine,
  buildWorkflowPrompt,
  isCopilotAuthError,
  type AgentConfig,
  type EngineDeps,
} from "@sre/sre-agent";
import type { Tool } from "@github/copilot-sdk";
import { SseHub } from "./sse.js";
import type { ServerEvent } from "../shared/events.js";

export class BusyError extends Error {
  constructor() {
    super("a turn is already running");
    this.name = "BusyError";
  }
}

const CONFIRM_TIMEOUT_MS = 5 * 60_000;

export interface EngineHostOptions {
  config: AgentConfig;
  tools: Tool<unknown>[];
  /** Seam: defaults to `new ChatEngine(deps)`; tests inject a fake. */
  engineFactory?: (deps: EngineDeps) => ChatEngine;
  /** Seam: defaults to the SseHub broadcast; tests capture events. */
  emit?: (event: ServerEvent) => void;
  /** Seam: defaults to randomUUID; tests pin confirm ids. */
  idFactory?: () => string;
  hub?: SseHub;
}

export interface EngineHost {
  hub: SseHub;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(prompt: string): Promise<void>;
  resolveConfirm(id: string, approve: boolean): void;
  abort(): Promise<void>;
  isTurnRunning(): boolean;
  authStatus(): Promise<void>;
  emit(event: ServerEvent): void;
}

export const createEngineHost = (opts: EngineHostOptions): EngineHost => {
  const hub = opts.hub ?? new SseHub();
  const emit = opts.emit ?? ((e: ServerEvent) => hub.broadcast(e));
  const newId = opts.idFactory ?? randomUUID;
  const engineFactory = opts.engineFactory ?? ((deps: EngineDeps) => new ChatEngine(deps));
  const pending = new Map<string, (approve: boolean) => void>();
  let turnRunning = false;

  const confirm = (summary: string): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      const id = newId();
      const timer = setTimeout(() => {
        if (pending.delete(id)) resolve(false); // closed tab -> decline, never wedge a turn
      }, CONFIRM_TIMEOUT_MS);
      pending.set(id, (approve) => {
        clearTimeout(timer);
        pending.delete(id);
        resolve(approve);
      });
      emit({ type: "confirm-request", id, summary });
    });

  const engine = engineFactory({
    config: opts.config,
    tools: opts.tools,
    confirm,
    onDelta: (text) => emit({ type: "delta", text }),
    onToolStart: (name) => emit({ type: "tool-start", name }),
  });

  const authStatus = async () => {
    try {
      const s = await engine.getAuthStatus();
      emit({
        type: "auth-status",
        isAuthenticated: s.isAuthenticated,
        authType: s.authType,
        login: s.login,
        ambientEnvWarning: s.authType === "env" && !opts.config.copilot?.githubToken,
      });
    } catch (e) {
      emit({ type: "engine-state", state: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  return {
    hub,
    emit,
    isTurnRunning: () => turnRunning,
    async start() {
      emit({ type: "engine-state", state: "starting" });
      await engine.start();
      emit({ type: "engine-state", state: "ready" });
      await authStatus();
    },
    async stop() {
      await engine.stop();
    },
    async send(prompt) {
      if (turnRunning) throw new BusyError();
      turnRunning = true;
      try {
        await engine.send(buildWorkflowPrompt(prompt) ?? prompt);
        emit({ type: "turn-end" });
      } catch (e) {
        emit({
          type: "turn-error",
          message: e instanceof Error ? e.message : String(e),
          isAuthError: isCopilotAuthError(e),
        });
      } finally {
        turnRunning = false;
      }
    },
    resolveConfirm(id, approve) {
      pending.get(id)?.(approve);
    },
    async abort() {
      await engine.abort();
    },
    authStatus,
  };
};
