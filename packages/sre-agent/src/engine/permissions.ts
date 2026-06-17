import type { PermissionHandler } from "@github/copilot-sdk";

/** Tools that mutate external state and must pass the confirm gate. */
const WRITE_TOOLS = new Set(["create_bug_from_incident"]);

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
