import { describe, it, expect, vi } from "vitest";
import type { McpRuntime } from "@sre/core";
import { buildAnalyzeCodeTool, CODE_ANALYSER_TOOL_NAMES } from "../src/tools/analyzeCode.js";
import type { ChatEngine } from "../src/engine/engine.js";

// The handler only maps specs to tools and delegates; a bare runtime stub suffices.
const runtime = { config: {} } as unknown as McpRuntime;

const makeEngine = (impl?: () => Promise<string>) =>
  ({ runSubAgent: vi.fn(impl ?? (async () => "THE REPORT")) }) as unknown as ChatEngine;

// Mirror tests/tools.test.ts: the Copilot handler is invoked with (args, context).
const call = (tool: ReturnType<typeof buildAnalyzeCodeTool>, args: object) =>
  (tool.handler as (a: object, c: object) => Promise<object>)(args, {});

describe("analyze_code tool", () => {
  it("delegates to runSubAgent with the restricted toolset and the code_analysis prompt", async () => {
    const engine = makeEngine();
    const tool = buildAnalyzeCodeTool(runtime, () => engine);
    const res = await call(tool, {
      repo_url: "https://dev.azure.com/Org/P/_git/pay",
      error_text: "TypeError at charge.ts:42",
      incident_number: "INC0012345"
    });
    expect(res).toEqual({ report: "THE REPORT" });

    const { tools, prompt } = (engine.runSubAgent as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(new Set(tools.map((t: { name: string }) => t.name))).toEqual(
      new Set(CODE_ANALYSER_TOOL_NAMES)
    );
    expect(prompt).toContain("https://dev.azure.com/Org/P/_git/pay");
    expect(prompt).toContain("TypeError at charge.ts:42");
    expect(prompt).toContain("INC0012345");
  });

  it("returns { error } instead of throwing when the sub-agent fails", async () => {
    const engine = makeEngine(async () => {
      throw new Error("sub-agent timeout");
    });
    const tool = buildAnalyzeCodeTool(runtime, () => engine);
    const res = await call(tool, { repo_url: "u", error_text: "e" });
    expect(res).toEqual({ error: "sub-agent timeout" });
  });

  it("labels the sub-agent 'Code Analyser'", async () => {
    const engine = makeEngine();
    const tool = buildAnalyzeCodeTool(runtime, () => engine);
    await call(tool, { repo_url: "u", error_text: "e" });
    const arg = (engine.runSubAgent as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.agentLabel).toBe("Code Analyser");
  });

  it("the restricted toolset is exactly repo tools + get_incident", () => {
    expect([...CODE_ANALYSER_TOOL_NAMES].sort()).toEqual(
      ["checkout_repo", "get_incident", "read_repo_file", "repo_history", "search_repo"].sort()
    );
  });
});
