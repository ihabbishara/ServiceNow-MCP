// packages/web/client/src/state.ts
import type { ServerEvent, EngineState } from "../../shared/events.js";

export interface SubAgentActivity {
  agent: string;
  error?: string;
  /** Wall-clock duration string (e.g. "34s") once the sub-agent finished. */
  duration?: string;
}

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  text: string;
  /** Sub-agent run that happened during this turn (folded in at turn end). */
  activity?: SubAgentActivity;
}
export interface ChatState {
  messages: ChatMessage[];
  streaming: string;
  busy: boolean;
  activeTool?: string;
  engineState: EngineState;
  auth: { isAuthenticated: boolean; authType?: string; login?: string; ambientEnvWarning: boolean };
  config?: {
    llmMode: "seat" | "byok";
    model: string;
    provider?: string;
    servicenow: boolean;
    ado: boolean;
    rag: boolean;
    uploadMaxBytes?: number;
  };
  ingest: Record<string, { phase: string; detail?: string; chunks?: number; reason?: string }>;
  deviceCode?: { verificationUri: string; userCode: string };
  confirm?: { id: string; summary: string };
  error?: { message: string; isAuthError: boolean };
  subagent?: SubAgentActivity & { done: boolean };
  nextMessageId: number;
}

export const initialState: ChatState = {
  messages: [],
  streaming: "",
  busy: false,
  engineState: "starting",
  auth: { isAuthenticated: false, ambientEnvWarning: false },
  nextMessageId: 0,
  ingest: {}
};

export type ClientEvent = { type: "user-message"; text: string };

// Fold the live sub-agent block (if any) into a transcript message so the
// timeline survives the end of the turn.
const foldActivity = (
  s: ChatState,
  streamingText: string
): Pick<ChatState, "messages" | "nextMessageId" | "subagent"> => {
  const activity = s.subagent
    ? { agent: s.subagent.agent, error: s.subagent.error, duration: s.subagent.duration }
    : undefined;
  const hasMsg = !!streamingText || !!activity;
  return {
    subagent: undefined,
    messages: hasMsg
      ? [
          ...s.messages,
          {
            id: s.nextMessageId,
            role: "assistant" as const,
            text: streamingText,
            ...(activity ? { activity } : {})
          }
        ]
      : s.messages,
    nextMessageId: hasMsg ? s.nextMessageId + 1 : s.nextMessageId
  };
};

export const applyServerEvent = (s: ChatState, e: ServerEvent | ClientEvent): ChatState => {
  switch (e.type) {
    case "user-message":
      return {
        ...s,
        busy: true,
        messages: [...s.messages, { id: s.nextMessageId, role: "user", text: e.text }],
        nextMessageId: s.nextMessageId + 1
      };
    case "delta":
      return { ...s, streaming: s.streaming + e.text, activeTool: undefined };
    case "turn-end":
      return {
        ...s,
        busy: false,
        activeTool: undefined,
        streaming: "",
        ...foldActivity(s, s.streaming)
      };
    case "turn-error":
      return {
        ...s,
        busy: false,
        activeTool: undefined,
        streaming: "",
        error: { message: e.message, isAuthError: e.isAuthError },
        ...foldActivity(s, "")
      };
    case "confirm-request":
      return { ...s, confirm: { id: e.id, summary: e.summary } };
    case "device-code":
      return { ...s, deviceCode: { verificationUri: e.verificationUri, userCode: e.userCode } };
    case "auth-status":
      return {
        ...s,
        deviceCode: undefined,
        auth: {
          isAuthenticated: e.isAuthenticated,
          authType: e.authType,
          login: e.login,
          ambientEnvWarning: e.ambientEnvWarning
        }
      };
    case "engine-state":
      return { ...s, engineState: e.state };
    case "config-status":
      return {
        ...s,
        config: {
          llmMode: e.llmMode,
          model: e.model,
          provider: e.provider,
          servicenow: e.servicenow,
          ado: e.ado,
          rag: e.rag,
          uploadMaxBytes: e.uploadMaxBytes
        }
      };
    case "ingest-status":
      return {
        ...s,
        ingest: {
          ...s.ingest,
          [e.source]: { phase: e.phase, detail: e.detail, chunks: e.chunks, reason: e.reason }
        }
      };
    case "tool-start":
      return { ...s, activeTool: e.name };
    case "subagent-status":
      switch (e.phase) {
        case "start":
          return { ...s, subagent: { agent: e.agent, done: false } };
        case "tool":
          return s; // steps are intentionally not surfaced
        case "done":
          return s.subagent
            ? { ...s, subagent: { ...s.subagent, done: true, duration: e.detail } }
            : s;
        case "error":
          return s.subagent
            ? { ...s, subagent: { ...s.subagent, error: e.detail, done: true } }
            : s;
        default:
          return s;
      }
    default:
      return s;
  }
};
