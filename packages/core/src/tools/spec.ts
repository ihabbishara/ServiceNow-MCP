import type { z } from "zod";
import type { AppConfig } from "../config.js";
import type { McpRuntime } from "../runtime.js";

/**
 * Expected, user-facing tool failure (bad input, not found, integration
 * unavailable). Adapters surface `message` verbatim; anything else thrown
 * from `run` is formatted as an unexpected error.
 */
export class ToolError extends Error {}

export interface ToolSpec<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  /** One description serving both surfaces (MCP + Copilot). */
  description: string;
  /** Raw zod shape: MCP registers it directly, the Copilot adapter wraps it in z.object(). */
  schema: Shape;
  /** Mutates external state → permission-gated on Copilot and listed in WRITE_TOOL_NAMES. */
  write?: boolean;
  /** Returns a user-facing message when the tool is unavailable under this config, else null. */
  enabledWhen?: (c: AppConfig) => string | null;
  run(rt: McpRuntime, args: z.infer<z.ZodObject<Shape>>): Promise<object>;
}

/** Identity helper: full arg-type inference inside the spec, widened for the table. */
export const defineSpec = <S extends z.ZodRawShape>(spec: ToolSpec<S>): ToolSpec =>
  spec as ToolSpec;
