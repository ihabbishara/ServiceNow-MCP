import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOL_SPECS, ToolError } from "@sre/core";
import type { McpRuntime, ToolSpec } from "@sre/core";

interface McpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

const errorResult = (text: string): McpToolResult => ({
  content: [{ type: "text", text }],
  isError: true
});

export const toMcpHandler =
  (spec: ToolSpec, runtime: McpRuntime) =>
  async (args: Record<string, unknown>): Promise<McpToolResult> => {
    try {
      const disabled = spec.enabledWhen?.(runtime.config);
      if (disabled) return errorResult(disabled);
      const result = await spec.run(runtime, args as never);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      if (err instanceof ToolError) return errorResult(err.message);
      return errorResult(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

export const registerRegistryTools = (server: McpServer, runtime: McpRuntime): void => {
  for (const spec of TOOL_SPECS) {
    server.tool(spec.name, spec.description, spec.schema, toMcpHandler(spec, runtime));
  }
};
