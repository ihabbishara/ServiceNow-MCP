import { defineTool } from "@github/copilot-sdk";
import { z } from "zod";
import { TOOL_SPECS, promptSpec } from "@sre/core";
import type { McpRuntime } from "@sre/core";
import { toCopilotTool } from "./index.js";
import type { ChatEngine } from "../engine/engine.js";

/** The Code Analyser's restricted toolset: repo primitives + incident context. */
export const CODE_ANALYSER_TOOL_NAMES = [
  "checkout_repo",
  "search_repo",
  "read_repo_file",
  "repo_history",
  "get_incident"
] as const;

/**
 * Copilot tool that delegates code root-cause analysis to a Code Analyser
 * sub-agent (a second session with only the repo tools + get_incident). The
 * main chat receives the analyser's report, never the raw code context.
 * `getEngine` is a lazy ref: the engine is constructed with this tool in its
 * toolset, so the reference resolves only at call time.
 */
export const buildAnalyzeCodeTool = (runtime: McpRuntime, getEngine: () => ChatEngine) =>
  defineTool("analyze_code", {
    description:
      "Delegate code root-cause analysis to the Code Analyser sub-agent. Provide the Azure DevOps " +
      "repo clone URL (ask the user for it: https://dev.azure.com/<org>/<project>/_git/<repo>), the " +
      "incident's error text / stack traces, and optionally the deployed branch or tag. Returns a " +
      "report with suspect file:line locations, hypothesis, evidence, and confidence.",
    skipPermission: true,
    parameters: z.object({
      repo_url: z.string().describe("Azure DevOps repo clone URL"),
      error_text: z.string().describe("Error messages / stack traces from the incident"),
      incident_number: z.string().optional().describe("Related incident number, e.g. INC0012345"),
      ref: z.string().optional().describe("Branch or tag matching the deployed version")
    }),
    handler: async (args) => {
      try {
        const prompt = promptSpec("code_analysis").build(args);
        const tools = TOOL_SPECS.filter((s) =>
          (CODE_ANALYSER_TOOL_NAMES as readonly string[]).includes(s.name)
        ).map((s) => toCopilotTool(s, runtime));
        const report = await getEngine().runSubAgent({
          tools,
          prompt,
          agentLabel: "Code Analyser"
        });
        return { report };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    }
  });
