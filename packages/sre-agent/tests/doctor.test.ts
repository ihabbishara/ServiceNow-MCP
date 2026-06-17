import { describe, it, expect, vi } from "vitest";
import { runDoctor } from "../src/doctor.js";

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
