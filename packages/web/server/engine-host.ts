// packages/web/server/engine-host.ts
import { randomUUID } from "node:crypto";
import {
  ChatEngine,
  buildWorkflowPrompt,
  isCopilotAuthError,
  copilotLogin,
  loadAgentConfig,
  resolveDotenvPath,
  loadDotenv,
  type AgentConfig,
  type EngineDeps,
} from "@sre/sre-agent";
import type { Tool } from "@github/copilot-sdk";
import { SseHub } from "./sse.js";
import { readEnvFile, writeEnvFile } from "./dotenv-file.js";
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
  /** Seam: builds the ONNX/knowledge runtime; tests inject a lightweight fake. */
  runtimeFactory?: () => { knowledge: { close(): Promise<unknown> } };
  /** Seam: defaults to copilotLogin; tests inject a mock. */
  loginFn?: typeof copilotLogin;
  /** Seam: defaults to loadAgentConfig; tests inject a mock. */
  loadConfig?: typeof loadAgentConfig;
  /** Seam: path to the .env file; defaults to resolveDotenvPath(). */
  envPath?: string;
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
  login(): Promise<void>;
  readEnv(): Promise<Record<string, string>>;
  applyEnv(vars: Record<string, string>): Promise<{ ok: true } | { ok: false; issues: string }>;
}

export const createEngineHost = (opts: EngineHostOptions): EngineHost => {
  const hub = opts.hub ?? new SseHub();
  const emit = opts.emit ?? ((e: ServerEvent) => hub.broadcast(e));
  const newId = opts.idFactory ?? randomUUID;
  const engineFactory = opts.engineFactory ?? ((deps: EngineDeps) => new ChatEngine(deps));
  const pending = new Map<string, (approve: boolean) => void>();
  let turnRunning = false;

  // Lifecycle seams
  const loginFn = opts.loginFn ?? copilotLogin;
  const loadConfig = opts.loadConfig ?? loadAgentConfig;
  const envPath = opts.envPath ?? resolveDotenvPath();
  let config = opts.config;

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

  const buildEngine = (cfg: AgentConfig) =>
    engineFactory({
      config: cfg,
      tools: opts.tools,
      confirm,
      onDelta: (text) => emit({ type: "delta", text }),
      onToolStart: (name) => emit({ type: "tool-start", name }),
    });

  let engine = buildEngine(config);
  let runtime = opts.runtimeFactory?.();

  const authStatus = async () => {
    try {
      const s = await engine.getAuthStatus();
      emit({
        type: "auth-status",
        isAuthenticated: s.isAuthenticated,
        authType: s.authType,
        login: s.login,
        ambientEnvWarning: s.authType === "env" && !config.copilot?.githubToken,
      });
    } catch (e) {
      emit({ type: "engine-state", state: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  const restart = async () => {
    emit({ type: "engine-state", state: "restarting" });
    await engine.stop();
    await runtime?.knowledge.close().catch(() => {}); // ONNX: dispose before re-create
    engine = buildEngine(config);
    runtime = opts.runtimeFactory?.();
    await engine.start();
    emit({ type: "engine-state", state: "ready" });
    await authStatus();
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
    async login() {
      await loginFn({
        home: config.copilot?.home,
        onDeviceCode: (info) =>
          emit({ type: "device-code", verificationUri: info.verificationUri, userCode: info.userCode }),
      });
      await restart();
    },
    async readEnv() {
      return envPath ? readEnvFile(envPath) : {};
    },
    async applyEnv(vars) {
      if (!envPath) return { ok: false as const, issues: "no .env path resolved" };
      let nextConfig: AgentConfig;
      try {
        nextConfig = loadConfig({ ...process.env, ...vars }); // validate BEFORE writing
      } catch (e) {
        return { ok: false as const, issues: e instanceof Error ? e.message : String(e) };
      }
      await writeEnvFile(envPath, vars);
      if (loadDotenv) loadDotenv(); // refresh process.env from the file
      config = nextConfig;
      await restart();
      return { ok: true as const };
    },
  };
};
