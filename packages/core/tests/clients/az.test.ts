import { describe, it, expect, vi } from "vitest";
import { AzRunner, winQuote } from "../../src/clients/ado/az.js";

const fakeExec = (code: number, stdout: string, stderr = "") =>
  vi.fn(async (_file: string, _args: string[]) => {
    if (code !== 0) throw Object.assign(new Error(stderr), { code, stdout, stderr });
    return { stdout, stderr };
  });

describe("AzRunner", () => {
  it("returns parsed JSON on exit 0 and ignores stderr warnings", async () => {
    const exec = fakeExec(0, '{"id":1}', "WARNING: extension auto-installed");
    const runner = new AzRunner("az", exec as any);
    const out = await runner.json<{ id: number }>(["boards", "work-item", "show", "--id", "1"]);
    expect(out).toEqual({ id: 1 });
    const args = exec.mock.calls[0][1] as string[];
    expect(args).toContain("--output");
    expect(args).toContain("json");
    expect(args).toContain("--only-show-errors");
  });

  it("passes the configured az path as the executable", async () => {
    const exec = fakeExec(0, "{}");
    const runner = new AzRunner("/usr/local/bin/az", exec as any);
    await runner.json(["account", "show"]);
    expect(exec.mock.calls[0][0]).toBe("/usr/local/bin/az");
  });

  it("throws with stderr on non-zero exit", async () => {
    const exec = fakeExec(1, "", "ERROR: Please run 'az login'");
    const runner = new AzRunner("az", exec as any);
    await expect(runner.json(["boards", "work-item", "show", "--id", "1"])).rejects.toThrow(/az login/);
  });
});

describe("winQuote", () => {
  it("quotes a metacharacter-only argument so cmd cannot break out (injection guard)", () => {
    // Previously returned bare "report&calc.exe" — the & would run calc.exe under cmd.
    expect(winQuote("report&calc.exe")).toBe('"report&calc.exe"');
    expect(winQuote("a|b")).toBe('"a|b"');
    expect(winQuote("a>b")).toBe('"a>b"');
  });

  it("quotes whitespace and empty args", () => {
    expect(winQuote("a b")).toBe('"a b"');
    expect(winQuote("")).toBe('""');
  });

  it("escapes embedded double quotes and trailing backslashes", () => {
    expect(winQuote('he said "hi"')).toBe('"he said \\"hi\\""');
    expect(winQuote("path\\")).toBe('"path\\\\"');
  });
});
