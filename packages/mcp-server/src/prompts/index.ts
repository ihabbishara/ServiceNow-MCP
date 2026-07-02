import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PROMPT_SPECS } from "@sre/core";
import type { McpRuntime } from "@sre/core";

/**
 * Registers every core PROMPT_SPECS entry as an MCP prompt. The registry owns
 * names, descriptions, argument schemas, and prompt bodies; this adapter only
 * wraps the built text in the single-user-message envelope MCP expects.
 */
export const registerPrompts = (server: McpServer, _runtime: McpRuntime): void => {
  for (const spec of PROMPT_SPECS) {
    server.prompt(spec.name, spec.description, spec.schema, async (args) => ({
      messages: [
        {
          role: "user" as const,
          content: { type: "text" as const, text: spec.build(args as never) }
        }
      ]
    }));
  }
};
