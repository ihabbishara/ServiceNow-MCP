import { describe, it, expect, vi } from "vitest";
import { runDoctor, summarizeDoctor, type CheckResult } from "../src/doctor.js";

describe("runDoctor", () => {
  it("passes when az account show succeeds", async () => {
    const exec = vi.fn(async () => ({ stdout: '{"user":{}}', stderr: "" }));
    await expect(runDoctor("az", exec as any)).resolves.toBeUndefined();
  });

  it("invokes the configured az path with account show", async () => {
    const exec = vi.fn(async () => ({ stdout: "{}", stderr: "" }));
    await runDoctor("/usr/local/bin/az", exec as any);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0][0]).toBe("/usr/local/bin/az");
    expect(exec.mock.calls[0][1]).toEqual(["account", "show", "--output", "json", "--only-show-errors"]);
  });

  it("throws 'az login' guidance when not logged in", async () => {
    const exec = vi.fn(async () => {
      throw Object.assign(new Error("Please run az login"), { code: 1 });
    });
    await expect(runDoctor("az", exec as any)).rejects.toThrow(/az login/);
  });
});

describe("summarizeDoctor", () => {
  const ok: CheckResult = { name: "Node.js >= 20", ok: true, detail: "v22.0.0" };
  const bad: CheckResult = {
    name: "Azure CLI login",
    ok: false,
    detail: "az account show failed",
    fix: "Run `az login`."
  };

  it("marks passing checks with a check and no fix line", () => {
    const { text } = summarizeDoctor([ok]);
    expect(text).toContain("✓ Node.js >= 20");
    expect(text).toContain("v22.0.0");
    expect(text).not.toContain("fix:");
  });

  it("marks failing checks with a cross and surfaces the fix", () => {
    const { text } = summarizeDoctor([bad]);
    expect(text).toContain("✗ Azure CLI login");
    expect(text).toContain("fix: Run `az login`.");
  });

  it("reports allOk=true only when every check passes", () => {
    expect(summarizeDoctor([ok]).allOk).toBe(true);
    expect(summarizeDoctor([ok, bad]).allOk).toBe(false);
  });

  it("footer reflects overall status", () => {
    expect(summarizeDoctor([ok]).text).toMatch(/All checks passed/);
    expect(summarizeDoctor([ok, bad]).text).toMatch(/failed/i);
  });
});
