import { describe, it, expect, vi } from "vitest";
import type { PermissionRequest } from "@github/copilot-sdk";
import { makePermissionHandler } from "../src/engine/permissions.js";
import { WRITE_TOOL_NAMES } from "@sre/core";

const inv = {} as never;

const customTool = (toolName: string): PermissionRequest =>
  ({ kind: "custom-tool", toolName, toolDescription: "" }) as PermissionRequest;

describe("permission gate", () => {
  it("approves a write when confirm() returns true", async () => {
    const confirm = vi.fn(async () => true);
    const h = makePermissionHandler({ confirmWrites: true }, confirm);
    const r = await h(customTool("create_bug_from_incident"), inv);
    expect(r).toEqual({ kind: "approve-once" });
    expect(confirm).toHaveBeenCalledOnce();
  });

  it("rejects with feedback when confirm() returns false", async () => {
    const h = makePermissionHandler({ confirmWrites: true }, async () => false);
    const r = await h(customTool("create_bug_from_incident"), inv);
    expect(r.kind).toBe("reject");
    expect((r as { feedback?: string }).feedback).toMatch(/declin/i);
  });

  it("auto-approves the write without prompting when confirmWrites is false", async () => {
    const confirm = vi.fn(async () => false);
    const h = makePermissionHandler({ confirmWrites: false }, confirm);
    const r = await h(customTool("create_bug_from_incident"), inv);
    expect(r).toEqual({ kind: "approve-once" });
    expect(confirm).not.toHaveBeenCalled();
  });

  it("auto-approves non-write tools without prompting", async () => {
    const confirm = vi.fn(async () => false);
    const h = makePermissionHandler({ confirmWrites: true }, confirm);
    const r = await h(customTool("get_incident"), inv);
    expect(r).toEqual({ kind: "approve-once" });
    expect(confirm).not.toHaveBeenCalled();
  });

  it("auto-approves non-custom-tool permission kinds", async () => {
    const h = makePermissionHandler({ confirmWrites: true }, async () => false);
    const r = await h({ kind: "read", path: "/tmp/x" } as unknown as PermissionRequest, inv);
    expect(r).toEqual({ kind: "approve-once" });
  });

  it("gates every registry write tool, not just create_bug_from_incident", async () => {
    const confirm = vi.fn(async () => true);
    const h = makePermissionHandler({ confirmWrites: true }, confirm);
    for (const toolName of [...WRITE_TOOL_NAMES]) {
      const res = await h({ kind: "custom-tool", toolName, toolDescription: "" } as never);
      expect(res).toEqual({ kind: "approve-once" });
    }
    expect(confirm).toHaveBeenCalledTimes(WRITE_TOOL_NAMES.size);
  });
});
