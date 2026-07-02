import { incidentSpecs } from "./specs/incidents.js";
import type { ToolSpec } from "./spec.js";

export { ToolError, defineSpec } from "./spec.js";
export type { ToolSpec } from "./spec.js";

/** Single source of truth: every tool on every surface, defined exactly once. */
export const TOOL_SPECS: ToolSpec[] = [...incidentSpecs];

/** Names of tools that mutate external state; derived, never hand-maintained. */
export const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(
  TOOL_SPECS.filter((s) => s.write).map((s) => s.name)
);
