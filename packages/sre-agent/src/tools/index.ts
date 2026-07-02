import { defineTool } from "@github/copilot-sdk";
import { z } from "zod";
import { TOOL_SPECS, ToolError } from "@sre/core";
import type { McpRuntime, ToolSpec } from "@sre/core";

/**
 * Copilot adapter over the core tool registry. Read tools skip the permission
 * gate; write tools (spec.write) surface a permission request handled by
 * makePermissionHandler. Handlers never throw: expected failures (ToolError)
 * and unexpected errors both come back as { error } so the model sees a
 * structured error instead of the turn failing.
 */
export const toCopilotTool = (spec: ToolSpec, runtime: McpRuntime) =>
  defineTool(spec.name, {
    description: spec.description,
    skipPermission: !spec.write,
    parameters: z.object(spec.schema),
    handler: async (args: unknown) => {
      try {
        const disabled = spec.enabledWhen?.(runtime.config);
        if (disabled) return { error: disabled };
        return await spec.run(runtime, args as never);
      } catch (err) {
        return { error: err instanceof ToolError ? err.message : String(err) };
      }
    }
  });

/** Tools not yet migrated to the core registry — shrinks to [] by Task 7, then this scaffold is deleted. */
const legacyTools = (_runtime: McpRuntime) => [];

export const buildTools = (runtime: McpRuntime) => [
  ...TOOL_SPECS.map((s) => toCopilotTool(s, runtime)),
  ...legacyTools(runtime)
];
