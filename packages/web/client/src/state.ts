// packages/web/client/src/state.ts
import type { ServerEvent, EngineState } from "../../shared/events.js";

export interface ChatMessage { id: number; role: "user" | "assistant"; text: string }
export interface ChatState {
  messages: ChatMessage[];
  streaming: string;
  engineState: EngineState;
  auth: { isAuthenticated: boolean; authType?: string; login?: string; ambientEnvWarning: boolean };
  deviceCode?: { verificationUri: string; userCode: string };
  confirm?: { id: string; summary: string };
  error?: { message: string; isAuthError: boolean };
  nextMessageId: number;
}

export const initialState: ChatState = {
  messages: [],
  streaming: "",
  engineState: "starting",
  auth: { isAuthenticated: false, ambientEnvWarning: false },
  nextMessageId: 0,
};

export type ClientEvent = { type: "user-message"; text: string };

export const applyServerEvent = (s: ChatState, e: ServerEvent | ClientEvent): ChatState => {
  switch (e.type) {
    case "user-message":
      return {
        ...s,
        messages: [...s.messages, { id: s.nextMessageId, role: "user", text: e.text }],
        nextMessageId: s.nextMessageId + 1,
      };
    case "delta":
      return { ...s, streaming: s.streaming + e.text };
    case "turn-end":
      return {
        ...s,
        messages: s.streaming
          ? [...s.messages, { id: s.nextMessageId, role: "assistant", text: s.streaming }]
          : s.messages,
        streaming: "",
        nextMessageId: s.streaming ? s.nextMessageId + 1 : s.nextMessageId,
      };
    case "turn-error":
      return { ...s, streaming: "", error: { message: e.message, isAuthError: e.isAuthError } };
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
          ambientEnvWarning: e.ambientEnvWarning,
        },
      };
    case "engine-state":
      return { ...s, engineState: e.state };
    case "tool-start":
      return s; // surfaced transiently elsewhere; no state change
    default:
      return s;
  }
};
