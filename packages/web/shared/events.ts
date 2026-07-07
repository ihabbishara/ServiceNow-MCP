// packages/web/shared/events.ts
export type EngineState = "starting" | "ready" | "restarting" | "error";

export type ServerEvent =
  | { type: "delta"; text: string }
  | { type: "tool-start"; name: string }
  | { type: "turn-end" }
  | { type: "turn-error"; message: string; isAuthError: boolean }
  | { type: "confirm-request"; id: string; summary: string }
  | { type: "device-code"; verificationUri: string; userCode: string }
  | {
      type: "auth-status";
      isAuthenticated: boolean;
      authType?: string;
      login?: string;
      ambientEnvWarning: boolean;
    }
  | {
      type: "config-status";
      llmMode: "seat" | "byok";
      model: string;
      provider?: string;
      servicenow: boolean;
      ado: boolean;
      rag: boolean;
      uploadMaxBytes: number;
    }
  | {
      type: "ingest-status";
      source: string;
      phase: "parsing" | "embedding" | "indexed" | "skipped" | "crawling";
      chunks?: number;
      reason?: string;
      detail?: string;
    }
  | { type: "engine-state"; state: EngineState; message?: string }
  | {
      type: "subagent-status";
      phase: "start" | "tool" | "done" | "error";
      agent: string;
      detail?: string;
    };
