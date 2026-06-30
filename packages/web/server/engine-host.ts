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
import { extractText, formatOf, defaultParsers } from "@sre/core";
import type { SourceRow, IngestDoc, IngestPhase, IngestResult } from "@sre/core";
import type { Tool } from "@github/copilot-sdk";
import { SseHub } from "./sse.js";
import { readEnvFields, writeEnvFile } from "./dotenv-file.js";
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
  runtimeFactory?: () => {
    knowledge: {
      close(): Promise<unknown>;
      indexDocument(doc: IngestDoc, onPhase?: (p: IngestPhase) => void): Promise<IngestResult>;
      crawl(overrides: { seeds?: string[]; allowDomains?: string[]; maxDepth?: number; maxPages?: number }, log?: (m: string) => void): Promise<{ chunksAdded: number; pagesCrawled: number }>;
      listSources(): Promise<SourceRow[]>;
      deleteSource(key: string): Promise<void>;
    };
  };
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
  readEnv(): Promise<{ vars: Record<string, string>; comments: Record<string, string> }>;
  applyEnv(vars: Record<string, string>): Promise<{ ok: true } | { ok: false; issues: string }>;
  snapshot(): ServerEvent[];
  ingestFile(name: string, bytes: Buffer): Promise<void>;
  ingestUrl(url: string): Promise<void>;
  listSources(): Promise<SourceRow[]>;
  deleteSource(url: string): Promise<void>;
  uploadMaxBytes: number;
}

export const createEngineHost = (opts: EngineHostOptions): EngineHost => {
  const hub = opts.hub ?? new SseHub();
  const baseEmit = opts.emit ?? ((e: ServerEvent) => hub.broadcast(e));
  let lastEngineState: ServerEvent | undefined;
  let lastAuthStatus: ServerEvent | undefined;
  let lastConfigStatus: ServerEvent | undefined;
  const emit = (e: ServerEvent) => {
    if (e.type === "engine-state") lastEngineState = e;
    else if (e.type === "auth-status") lastAuthStatus = e;
    else if (e.type === "config-status") lastConfigStatus = e;
    baseEmit(e);
  };
  const newId = opts.idFactory ?? randomUUID;
  const engineFactory = opts.engineFactory ?? ((deps: EngineDeps) => new ChatEngine(deps));
  const pending = new Map<string, (approve: boolean) => void>();
  let turnRunning = false;
  let turnGen = 0;

  // Lifecycle seams
  const loginFn = opts.loginFn ?? copilotLogin;
  const loadConfig = opts.loadConfig ?? loadAgentConfig;
  const runtimeFactory = opts.runtimeFactory;
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
  let runtime = runtimeFactory?.();

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

  const emitConfigStatus = () => {
    const raw = config.raw as unknown as Record<string, string | undefined> | undefined;
    emit({
      type: "config-status",
      llmMode: config.llm.mode,
      model: config.llm.model,
      provider: config.llm.provider?.type,
      servicenow: !!raw?.SERVICENOW_BASE_URL,
      ado:
        config.adoAuthMode === "pat"
          ? !!raw?.ADO_PAT
          : !!(raw?.ADO_ORG_URL && raw?.ADO_PROJECT),
      rag: !!runtime,
      uploadMaxBytes: config.uploadMaxBytes,
    });
  };

  const restart = async () => {
    emit({ type: "engine-state", state: "restarting" });
    await engine.abort(); // abort any in-flight turn
    turnRunning = false;
    turnGen++;
    await engine.stop();
    await runtime?.knowledge.close().catch(() => {}); // ONNX: dispose before re-create
    engine = buildEngine(config);
    runtime = runtimeFactory?.();
    await engine.start();
    emit({ type: "engine-state", state: "ready" });
    emitConfigStatus();
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
      emitConfigStatus();
      await authStatus();
    },
    async stop() {
      await engine.stop();
    },
    async send(prompt) {
      if (turnRunning) throw new BusyError();
      turnRunning = true;
      const myGen = ++turnGen;
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
        if (myGen === turnGen) turnRunning = false;
      }
    },
    resolveConfirm(id, approve) {
      pending.get(id)?.(approve);
    },
    async abort() {
      await engine.abort();
    },
    get uploadMaxBytes() { return config.uploadMaxBytes; },
    async ingestFile(name, bytes) {
      const source = `upload://${name}`;
      if (!runtime) {
        emit({ type: "ingest-status", source, phase: "skipped", reason: "knowledge index not configured" });
        return;
      }
      if (!formatOf(name)) {
        emit({ type: "ingest-status", source, phase: "skipped", reason: `unsupported format` });
        return;
      }
      emit({ type: "ingest-status", source, phase: "parsing" });
      try {
        const ex = await extractText(name, bytes, defaultParsers);
        if ("skipped" in ex) {
          emit({ type: "ingest-status", source, phase: "skipped", reason: ex.skipped });
          return;
        }
        const res = await runtime.knowledge.indexDocument(
          { key: source, title: name, text: ex.text },
          (p) => { if (p.phase === "embedding") emit({ type: "ingest-status", source, phase: "embedding", detail: `${p.done}/${p.total}` }); }
        );
        if (res.skipped) emit({ type: "ingest-status", source, phase: "skipped", reason: res.skipped });
        else emit({ type: "ingest-status", source, phase: "indexed", chunks: res.chunks });
      } catch (e) {
        emit({ type: "ingest-status", source, phase: "skipped", reason: e instanceof Error ? e.message : String(e) });
      }
    },
    async ingestUrl(url) {
      if (!runtime) {
        emit({ type: "ingest-status", source: url, phase: "skipped", reason: "knowledge index not configured" });
        return;
      }
      let host: string;
      try {
        host = new URL(url).host;
      } catch {
        emit({ type: "ingest-status", source: url, phase: "skipped", reason: "invalid url" });
        return;
      }
      emit({ type: "ingest-status", source: url, phase: "crawling" });
      try {
        // Ad-hoc add: allow the pasted URL's own host and bound the sweep so one
        // URL doesn't trigger a full-site crawl. allowDomains override makes the
        // URL in-scope even when it isn't in the configured CRAWL_ALLOW_DOMAINS.
        const res = await runtime.knowledge.crawl({ seeds: [url], allowDomains: [host], maxDepth: 1, maxPages: 25 });
        if (res.pagesCrawled === 0) {
          emit({ type: "ingest-status", source: url, phase: "skipped", reason: "nothing indexed (unreachable, blocked by robots, or no content)" });
        } else {
          emit({ type: "ingest-status", source: url, phase: "indexed", chunks: res.chunksAdded });
        }
      } catch (e) {
        emit({ type: "ingest-status", source: url, phase: "skipped", reason: e instanceof Error ? e.message : String(e) });
      }
    },
    async listSources() {
      return runtime ? runtime.knowledge.listSources() : [];
    },
    async deleteSource(url) {
      await runtime?.knowledge.deleteSource(url);
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
      return envPath ? readEnvFields(envPath) : { vars: {}, comments: {} };
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
      loadDotenv(); // refresh process.env from the file
      config = nextConfig;
      await restart();
      return { ok: true as const };
    },
    snapshot(): ServerEvent[] {
      return [lastEngineState, lastAuthStatus, lastConfigStatus].filter(Boolean) as ServerEvent[];
    },
  };
};
