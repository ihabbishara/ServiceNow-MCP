// packages/web/tests/state.test.ts
import { describe, it, expect } from "vitest";
import { applyServerEvent, initialState } from "../client/src/state.js";

describe("applyServerEvent", () => {
  it("accumulates delta text into the streaming buffer, flushes on turn-end", () => {
    let s = initialState;
    s = applyServerEvent(s, { type: "delta", text: "Hel" });
    s = applyServerEvent(s, { type: "delta", text: "lo" });
    expect(s.streaming).toBe("Hello");
    s = applyServerEvent(s, { type: "turn-end" });
    expect(s.streaming).toBe("");
    expect(s.messages.at(-1)).toMatchObject({ role: "assistant", text: "Hello" });
  });

  it("records a confirm request and clears it elsewhere", () => {
    let s = applyServerEvent(initialState, { type: "confirm-request", id: "x", summary: "delete?" });
    expect(s.confirm).toEqual({ id: "x", summary: "delete?" });
  });

  it("stores the device code", () => {
    const s = applyServerEvent(initialState, {
      type: "device-code",
      verificationUri: "https://github.com/login/device",
      userCode: "WDJB-MJHT",
    });
    expect(s.deviceCode).toEqual({ verificationUri: "https://github.com/login/device", userCode: "WDJB-MJHT" });
  });

  it("surfaces the ambient-env warning from auth-status", () => {
    const s = applyServerEvent(initialState, {
      type: "auth-status",
      isAuthenticated: true,
      authType: "env",
      ambientEnvWarning: true,
    });
    expect(s.auth.ambientEnvWarning).toBe(true);
  });
});
