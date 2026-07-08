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
    const s = applyServerEvent(initialState, {
      type: "confirm-request",
      id: "x",
      summary: "delete?"
    });
    expect(s.confirm).toEqual({ id: "x", summary: "delete?" });
  });

  it("stores the device code", () => {
    const s = applyServerEvent(initialState, {
      type: "device-code",
      verificationUri: "https://github.com/login/device",
      userCode: "WDJB-MJHT"
    });
    expect(s.deviceCode).toEqual({
      verificationUri: "https://github.com/login/device",
      userCode: "WDJB-MJHT"
    });
  });

  it("surfaces the ambient-env warning from auth-status", () => {
    const s = applyServerEvent(initialState, {
      type: "auth-status",
      isAuthenticated: true,
      authType: "env",
      ambientEnvWarning: true
    });
    expect(s.auth.ambientEnvWarning).toBe(true);
  });

  it("appends the user's own message on user-message", () => {
    const s = applyServerEvent(initialState, { type: "user-message", text: "hi there" });
    expect(s.messages.at(-1)).toMatchObject({ role: "user", text: "hi there" });
    expect(typeof s.messages.at(-1)!.id).toBe("number");
  });

  it("sets busy on user-message and clears it on turn-end", () => {
    let s = applyServerEvent(initialState, { type: "user-message", text: "hi" });
    expect(s.busy).toBe(true);
    s = applyServerEvent(s, { type: "turn-end" });
    expect(s.busy).toBe(false);
  });

  it("tracks the active tool and clears it on first delta", () => {
    let s = applyServerEvent(initialState, { type: "tool-start", name: "web_fetch" });
    expect(s.activeTool).toBe("web_fetch");
    s = applyServerEvent(s, { type: "delta", text: "x" });
    expect(s.activeTool).toBeUndefined();
  });

  it("clears busy and activeTool on turn-error", () => {
    let s = applyServerEvent(initialState, { type: "user-message", text: "hi" });
    s = applyServerEvent(s, { type: "tool-start", name: "t" });
    s = applyServerEvent(s, { type: "turn-error", message: "boom", isAuthError: false });
    expect(s.busy).toBe(false);
    expect(s.activeTool).toBeUndefined();
  });

  it("stores config from config-status", () => {
    const s = applyServerEvent(initialState, {
      type: "config-status",
      llmMode: "seat",
      model: "gpt-5",
      servicenow: true,
      ado: false,
      rag: true,
      uploadMaxBytes: 1024
    });
    expect(s.config).toMatchObject({
      llmMode: "seat",
      model: "gpt-5",
      servicenow: true,
      ado: false,
      rag: true
    });
  });

  it("tracks ingest-status per source", () => {
    let s = applyServerEvent(initialState, {
      type: "ingest-status",
      source: "upload://a.pdf",
      phase: "parsing"
    });
    s = applyServerEvent(s, {
      type: "ingest-status",
      source: "upload://a.pdf",
      phase: "embedding",
      detail: "2/5"
    });
    s = applyServerEvent(s, { type: "ingest-status", source: "https://h/p", phase: "crawling" });
    expect(s.ingest["upload://a.pdf"]).toEqual({
      phase: "embedding",
      detail: "2/5",
      chunks: undefined,
      reason: undefined
    });
    expect(s.ingest["https://h/p"].phase).toBe("crawling");
  });

  it("stores uploadMaxBytes from config-status", () => {
    const s = applyServerEvent(initialState, {
      type: "config-status",
      llmMode: "seat",
      model: "m",
      servicenow: true,
      ado: false,
      rag: true,
      uploadMaxBytes: 2048
    });
    expect(s.config?.uploadMaxBytes).toBe(2048);
  });
});

describe("subagent status block", () => {
  const seq = (events: Parameters<typeof applyServerEvent>[1][]) =>
    events.reduce(applyServerEvent, initialState);

  it("sets a labeled block on start and ignores tool events", () => {
    const s = seq([
      { type: "subagent-status", phase: "start", agent: "Code Analyser" },
      {
        type: "subagent-status",
        phase: "tool",
        agent: "Code Analyser",
        detail: 'search_repo — "x"'
      }
    ]);
    expect(s.subagent).toEqual({ agent: "Code Analyser", done: false });
  });

  it("marks done with a duration", () => {
    const s = seq([
      { type: "subagent-status", phase: "start", agent: "Code Analyser" },
      { type: "subagent-status", phase: "done", agent: "Code Analyser", detail: "34s" }
    ]);
    expect(s.subagent).toEqual({ agent: "Code Analyser", done: true, duration: "34s" });
  });

  it("records error phase", () => {
    const s = seq([
      { type: "subagent-status", phase: "start", agent: "Code Analyser" },
      { type: "subagent-status", phase: "error", agent: "Code Analyser", detail: "clone failed" }
    ]);
    expect(s.subagent).toMatchObject({ agent: "Code Analyser", error: "clone failed", done: true });
  });

  it("ignores tool/done/error without a preceding start", () => {
    expect(
      seq([{ type: "subagent-status", phase: "tool", agent: "X", detail: "y" }]).subagent
    ).toBeUndefined();
    expect(
      seq([{ type: "subagent-status", phase: "done", agent: "X", detail: "1s" }]).subagent
    ).toBeUndefined();
  });

  it("folds the block (agent + duration, no steps) into the assistant message on turn-end", () => {
    const s = seq([
      { type: "subagent-status", phase: "start", agent: "Code Analyser" },
      { type: "subagent-status", phase: "done", agent: "Code Analyser", detail: "5s" },
      { type: "delta", text: "Report: ..." },
      { type: "turn-end" }
    ]);
    expect(s.subagent).toBeUndefined();
    const last = s.messages.at(-1)!;
    expect(last.role).toBe("assistant");
    expect(last.text).toBe("Report: ...");
    expect(last.activity).toEqual({ agent: "Code Analyser", duration: "5s", error: undefined });
  });

  it("creates an activity-only assistant message when the turn ends with no text", () => {
    const s = seq([
      { type: "subagent-status", phase: "start", agent: "Code Analyser" },
      { type: "turn-end" }
    ]);
    expect(s.messages.at(-1)).toMatchObject({ role: "assistant", text: "" });
    expect(s.messages.at(-1)!.activity).toMatchObject({ agent: "Code Analyser" });
  });

  it("clears the live block on turn-error but keeps it in the transcript", () => {
    const s = seq([
      { type: "subagent-status", phase: "start", agent: "Code Analyser" },
      { type: "subagent-status", phase: "error", agent: "Code Analyser", detail: "boom" },
      { type: "turn-error", message: "turn failed", isAuthError: false }
    ]);
    expect(s.subagent).toBeUndefined();
    expect(s.messages.at(-1)!.activity).toMatchObject({ error: "boom" });
    expect(s.error?.message).toBe("turn failed");
  });
});
