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
 * Appended to the Copilot session's system message (append mode → keeps all SDK
 * guardrails) when the crawler is configured. Steers the model to consult the
 * internal-docs index via the `search_knowledge` tool for how-to/runbook
 * questions, in both seat and BYOK modes.
 */
export const KNOWLEDGE_SYSTEM_INSTRUCTION =
  "This agent has a `search_knowledge` tool backed by an index of the organization's internal " +
  "documentation (runbooks, wikis, KB). When the user asks a how-to, procedure, troubleshooting, " +
  "or known-fix question where internal documentation would help, call `search_knowledge` before " +
  "answering and cite the returned source URLs. If it returns no results, say the index may be empty " +
  "and suggest running `sre-agent crawl`. Do not call it for questions clearly answerable from " +
  "ServiceNow/ADO data alone.";

/** Appended when SharePoint is configured: steer toward get_incident_documents for incident docs. */
export const SHAREPOINT_SYSTEM_INSTRUCTION =
  "This agent has a `get_incident_documents` tool that retrieves an incident's supporting documents " +
  "(docx/xlsx/pptx/pdf) from SharePoint by incident number. When the user references an incident number " +
  "and asks about its documentation, runbook, postmortem, or details that may live in SharePoint, call " +
  "`get_incident_documents` (alongside the ServiceNow tools) and cite the document names you used.";

/** Appended when ADO is configured: steer toward analyze_code for code root-cause requests. */
export const CODE_ANALYSIS_SYSTEM_INSTRUCTION =
  "This agent has an `analyze_code` tool that checks out an Azure DevOps git repository and pinpoints " +
  "likely root-cause code locations for an incident's error output. When an incident contains stack " +
  "traces or error messages referencing application code and the user wants a root cause, first ask " +
  "the user for the repo clone URL in the format https://dev.azure.com/<org>/<project>/_git/<repo> " +
  "(and optionally the deployed branch/tag), then call `analyze_code` with that URL and the error text. " +
  "Relay the analyser's report and cite the suspect file:line locations.";

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
export const buildClientOptions = (
  config: AgentConfig,
  env: NodeJS.ProcessEnv = process.env
): CopilotClientOptions => {
  const options: CopilotClientOptions = {};
  if (config.llm.mode !== "seat") return options;
  if (config.copilot.githubToken) {
    // Explicit token wins; the SDK sets useLoggedInUser=false, so ambient env
    // tokens are ignored already — no need to scrub the env.
    options.gitHubToken = config.copilot.githubToken;
  } else if (config.copilot.ignoreEnvToken) {
    // No explicit token → use the stored `copilot login` OAuth (the identity the
    // copilot CLI uses). The SDK tries env tokens (COPILOT_GITHUB_TOKEN→GH_TOKEN→
    // GITHUB_TOKEN) BEFORE that OAuth, and an ambient repo/Actions token there is
    // almost never Copilot-enabled → it's sent and 403s. Strip those three from
    // the env handed to the runtime so the OAuth is used. Cleaning process.env
    // (not just the shell) also catches tokens injected via `node --env-file`.
    const cleaned = { ...env };
    delete cleaned.COPILOT_GITHUB_TOKEN;
    delete cleaned.GH_TOKEN;
    delete cleaned.GITHUB_TOKEN;
    options.env = cleaned;
  }
  if (config.copilot.home) options.baseDirectory = config.copilot.home;
  return options;
};

/** Progress event from a runSubAgent invocation, for UI surfaces to display. */
export interface SubAgentEvent {
  phase: "start" | "tool" | "done" | "error";
  /** Human label of the sub-agent, e.g. "Code Analyser". */
  agent: string;
  /** Phase detail: tool name + short arg summary, duration ("34s"), or error message. */
  detail?: string;
}

export interface EngineDeps {
  config: AgentConfig;
  tools: Tool<any>[];
  /** Used by the write permission gate to ask the user before a write executes. */
  confirm: (summary: string) => Promise<boolean>;
  onDelta: (text: string) => void;
  onToolStart?: (name: string) => void;
  /** Sub-agent progress (start/tool/done/error); optional — surfaces opt in. */
  onSubAgent?: (e: SubAgentEvent) => void;
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

// The most informative argument per repo tool; repo_url is never echoed (noise —
// the user supplied it) and values are flattened to one short line.
const DETAIL_ARG_KEYS = ["pattern", "path", "ref"] as const;
const toolDetail = (name: string, args?: Record<string, unknown>): string => {
  for (const key of DETAIL_ARG_KEYS) {
    const v = args?.[key];
    if (typeof v === "string" && v) {
      const flat = v.replace(/\s+/g, " ").trim();
      const short = flat.length > 60 ? `${flat.slice(0, 59)}…` : flat;
      return `${name} — "${short}"`;
    }
  }
  return name;
};

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

  /** BYOK provider block for a SessionConfig; empty object in seat mode. */
  private providerConfig(): Partial<SessionConfig> {
    const cfg = this.deps.config;
    return cfg.llm.mode === "byok" && cfg.llm.provider
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
      : {};
  }

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
      const systemInstructions = [
        cfg.knowledgeEnabled ? KNOWLEDGE_SYSTEM_INSTRUCTION : null,
        cfg.sharePointEnabled ? SHAREPOINT_SYSTEM_INSTRUCTION : null,
        cfg.app.azureDevOps.orgUrl ? CODE_ANALYSIS_SYSTEM_INSTRUCTION : null
      ].filter(Boolean);
      const sessionConfig: SessionConfig = {
        model: cfg.llm.model,
        streaming: true,
        tools: this.deps.tools,
        onPermissionRequest: permissionHandler,
        ...(systemInstructions.length
          ? { systemMessage: { mode: "append" as const, content: systemInstructions.join("\n\n") } }
          : {}),
        ...this.providerConfig()
      };

      this.session = await this.client.createSession(sessionConfig);

      this.unsubscribe.push(
        this.session.on("assistant.message_delta", (e) => this.deps.onDelta(e.data.deltaContent))
      );
      this.unsubscribe.push(
        this.session.on("tool.execution_start", (e) => this.deps.onToolStart?.(e.data.toolName))
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
   * are still delivered to the `onDelta` handler while it waits. The wait
   * deadline comes from `config.turnTimeoutMs` (TURN_TIMEOUT_MS) — the SDK
   * default is 60s, too short for reasoning models + slow ServiceNow turns,
   * which rejected mid-turn with "Timeout after 60000ms waiting for session.idle".
   */
  async send(prompt: string): Promise<void> {
    if (!this.session) throw new Error("engine not started");
    await this.session.sendAndWait(prompt, this.deps.config.turnTimeoutMs);
  }

  /**
   * Run a one-shot sub-agent: a second session on the same client with a
   * restricted toolset. Deltas are not streamed to the UI; they accumulate and
   * the final text returns. Progress is reported through `deps.onSubAgent`
   * (start → tool per execution → done/error) labeled with `agentLabel`;
   * sub-agent tool starts do NOT reach `deps.onToolStart` — that channel is
   * main-session activity only. The sub-session is disconnected afterwards;
   * the main session is untouched.
   */
  async runSubAgent(opts: {
    tools: Tool<any>[];
    prompt: string;
    agentLabel?: string;
  }): Promise<string> {
    if (!this.client) throw new Error("engine not started");
    const cfg = this.deps.config;
    const agent = opts.agentLabel ?? "sub-agent";
    const emit = (phase: SubAgentEvent["phase"], detail?: string) =>
      this.deps.onSubAgent?.({ phase, agent, ...(detail !== undefined ? { detail } : {}) });
    const startedAt = Date.now();
    emit("start");
    try {
      const session = await this.client.createSession({
        model: cfg.llm.model,
        streaming: true,
        tools: opts.tools,
        // Sub-agent toolset is read-only; deny anything that asks for permission.
        onPermissionRequest: async () => ({
          kind: "reject" as const,
          feedback: "Sub-agent tools are read-only."
        }),
        ...this.providerConfig()
      });
      const chunks: string[] = [];
      const offDelta = session.on("assistant.message_delta", (e) =>
        chunks.push(e.data.deltaContent)
      );
      const offTool = session.on("tool.execution_start", (e) =>
        emit("tool", toolDetail(e.data.toolName, e.data.arguments))
      );
      try {
        await session.sendAndWait(opts.prompt, cfg.turnTimeoutMs);
      } finally {
        offDelta();
        offTool();
        await session.disconnect().catch(() => undefined);
      }
      emit("done", `${Math.round((Date.now() - startedAt) / 1000)}s`);
      return chunks.join("");
    } catch (err) {
      emit("error", err instanceof Error ? err.message : String(err));
      throw err;
    }
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
