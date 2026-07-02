import type { PermissionHandler } from "@github/copilot-sdk";
import { WRITE_TOOL_NAMES } from "@sre/core";

/** Tools that mutate external state and must pass the confirm gate — derived from the registry. */
const WRITE_TOOLS = WRITE_TOOL_NAMES;

/**
 * Build an SDK `PermissionHandler` that gates the write tool(s).
 *
 * The SDK surfaces a custom-tool permission request as
 * `{ kind: "custom-tool", toolName, toolDescription, ... }`. For a write tool:
 *   - if `confirmWrites` is on, call `confirm(summary)` → approve-once or reject;
 *   - otherwise approve-once (writes pre-approved).
 * Every other request (read tools with skipPermission still surface nothing here;
 * any non-write custom tool or non-custom kind) is auto-approved.
 */
export const makePermissionHandler = (
  opts: { confirmWrites: boolean },
  confirm: (summary: string) => Promise<boolean>
): PermissionHandler => {
  return async (request) => {
    if (request.kind === "custom-tool" && WRITE_TOOLS.has(request.toolName)) {
      if (!opts.confirmWrites) {
        return { kind: "approve-once" };
      }
      const ok = await confirm(`Allow write tool "${request.toolName}"?`);
      return ok
        ? { kind: "approve-once" }
        : { kind: "reject", feedback: "User declined the write." };
    }
    return { kind: "approve-once" };
  };
};
