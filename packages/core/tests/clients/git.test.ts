import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitRepoClient, GitError, repoDirFor } from "../../src/clients/git.js";
import type { ExecFn } from "../../src/clients/ado/az.js";

const ADO = {
  orgUrl: "https://dev.azure.com/INGCDaaS",
  pat: undefined,
  gitWorkspaceDir: undefined
};
const URL_OK = "https://dev.azure.com/INGCDaaS/IngOne/_git/payments";

/** ExecFn fake: records calls, returns canned stdout per git subcommand.
 * NOTE: the subcommand is found by NAME (argv contains flag values like a dir
 * after -C or a header after -c that don't start with "-"). */
const GIT_SUBCOMMANDS = ["clone", "rev-parse", "grep", "log"];
const makeExec = (byCmd: Record<string, string> = {}) => {
  const calls: string[][] = [];
  const exec: ExecFn = vi.fn(async (_file, args) => {
    calls.push(args);
    const sub = args.find((a) => GIT_SUBCOMMANDS.includes(a));
    return { stdout: byCmd[sub ?? ""] ?? "", stderr: "" };
  });
  return { exec, calls };
};

const canned = { "rev-parse": "abc123\n" }; // both rev-parse calls get the same fake

describe("GitRepoClient URL allowlist", () => {
  const client = new GitRepoClient(ADO, makeExec().exec, () => false);

  it("rejects non-https, foreign hosts, wrong org, ssh, and garbage", async () => {
    for (const bad of [
      "http://dev.azure.com/INGCDaaS/IngOne/_git/payments",
      "https://evil.example/INGCDaaS/IngOne/_git/payments",
      "https://dev.azure.com/OtherOrg/IngOne/_git/payments",
      "git@ssh.dev.azure.com:v3/INGCDaaS/IngOne/payments",
      "not a url"
    ]) {
      await expect(client.ensureRepo(bad)).rejects.toBeInstanceOf(GitError);
    }
  });

  it("accepts dev.azure.com/<org> (case-insensitive) and <org>.visualstudio.com", async () => {
    const { exec } = makeExec(canned);
    const c = new GitRepoClient(ADO, exec, () => false);
    await expect(
      c.ensureRepo("https://dev.azure.com/ingcdaas/IngOne/_git/payments")
    ).resolves.toBeTruthy();
    await expect(
      c.ensureRepo("https://INGCDaaS.visualstudio.com/IngOne/_git/payments")
    ).resolves.toBeTruthy();
  });

  it("strips embedded credentials from the URL before cloning", async () => {
    const { exec, calls } = makeExec(canned);
    const c = new GitRepoClient(ADO, exec, () => false);
    await c.ensureRepo("https://someuser@dev.azure.com/INGCDaaS/IngOne/_git/payments");
    const cloneArgs = calls.find((a) => a.includes("clone"))!;
    expect(cloneArgs.join(" ")).not.toContain("someuser@");
  });
});

describe("GitRepoClient clone/auth", () => {
  it("clones shallow with --depth 50 and --branch when ref given", async () => {
    const { exec, calls } = makeExec(canned);
    const c = new GitRepoClient(ADO, exec, () => false);
    await c.ensureRepo(URL_OK, "release/1.2");
    const clone = calls.find((a) => a.includes("clone"))!;
    expect(clone).toContain("--depth");
    expect(clone).toContain("50");
    expect(clone).toContain("--branch");
    expect(clone).toContain("release/1.2");
  });

  it("with a PAT, sends Authorization via -c http.extraHeader and never in the URL", async () => {
    const { exec, calls } = makeExec(canned);
    const c = new GitRepoClient({ ...ADO, pat: "s3cretPAT" }, exec, () => false);
    await c.ensureRepo(URL_OK);
    const clone = calls.find((a) => a.includes("clone"))!;
    const b64 = Buffer.from(":s3cretPAT").toString("base64");
    expect(clone).toContain(`http.extraHeader=Authorization: Basic ${b64}`);
    expect(clone.join(" ")).not.toContain("s3cretPAT@");
  });

  it("without a PAT, passes no -c http.extraHeader", async () => {
    const { exec, calls } = makeExec(canned);
    const c = new GitRepoClient(ADO, exec, () => false);
    await c.ensureRepo(URL_OK);
    const clone = calls.find((a) => a.includes("clone"))!;
    expect(clone.join(" ")).not.toContain("http.extraHeader");
  });

  it("reuses an existing checkout without cloning (reused: true)", async () => {
    const { exec, calls } = makeExec(canned);
    const c = new GitRepoClient(ADO, exec, () => true);
    const info = await c.ensureRepo(URL_OK);
    expect(info.reused).toBe(true);
    expect(info.headSha).toBe("abc123");
    expect(calls.find((a) => a.includes("clone"))).toBeUndefined();
  });

  it("redacts the PAT and its base64 form from git error messages", async () => {
    const pat = "s3cretPAT";
    const b64 = Buffer.from(`:${pat}`).toString("base64");
    const exec: ExecFn = vi.fn(async () => {
      throw Object.assign(new Error("boom"), {
        stderr: `fatal: auth ${pat} / Basic ${b64} rejected`
      });
    });
    const c = new GitRepoClient({ ...ADO, pat }, exec, () => false);
    const err = await c.ensureRepo(URL_OK).catch((e) => e as GitError);
    expect(err).toBeInstanceOf(GitError);
    expect(err.message).not.toContain(pat);
    expect(err.message).not.toContain(b64);
  });
});

describe("GitRepoClient grep", () => {
  it("parses file:line:text matches and treats exit code 1 as no matches", async () => {
    const out = "src/pay.ts:42:  throw new PaymentError()\nsrc/pay.ts:99:// PaymentError docs\n";
    const exec: ExecFn = vi.fn(async (_f, args) => {
      if (args.includes("grep")) return { stdout: out, stderr: "" };
      return { stdout: "abc123\n", stderr: "" };
    });
    const c = new GitRepoClient(ADO, exec, () => true);
    const res = await c.grep(URL_OK, "PaymentError");
    expect(res.matches[0]).toEqual({
      file: "src/pay.ts",
      line: 42,
      text: "  throw new PaymentError()"
    });
    expect(res.truncated).toBe(false);

    const execNoMatch: ExecFn = vi.fn(async (_f, args) => {
      if (args.includes("grep")) throw Object.assign(new Error("no match"), { code: 1 });
      return { stdout: "abc123\n", stderr: "" };
    });
    const c2 = new GitRepoClient(ADO, execNoMatch, () => true);
    await expect(c2.grep(URL_OK, "nope")).resolves.toEqual({ matches: [], truncated: false });
  });

  it("caps matches at 200 and flags truncation", async () => {
    const out = Array.from({ length: 250 }, (_, i) => `f.ts:${i + 1}:x`).join("\n") + "\n";
    const exec: ExecFn = vi.fn(async (_f, args) =>
      args.includes("grep") ? { stdout: out, stderr: "" } : { stdout: "abc123\n", stderr: "" }
    );
    const c = new GitRepoClient(ADO, exec, () => true);
    const res = await c.grep(URL_OK, "x");
    expect(res.matches).toHaveLength(200);
    expect(res.truncated).toBe(true);
  });
});

describe("GitRepoClient readFile containment", () => {
  // Real temp dir: the checkout dir is precomputed with repoDirFor and prepared
  // on disk, exists() returns true so ensureRepo takes the reuse path (fake exec
  // only serves rev-parse) and readFile hits the real filesystem.
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), "git-client-test-"));
    const ado = { ...ADO, gitWorkspaceDir: root };
    const dir = repoDirFor(URL_OK, undefined, root);
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "line1\nline2\nline3\n");
    writeFileSync(join(dir, "src", "b.ts"), "unused\n");
    const { exec } = makeExec(canned);
    return { c: new GitRepoClient(ado, exec, () => true), dir, root };
  };

  it("reads a line slice with metadata", async () => {
    const { c } = setup();
    const res = await c.readFile(URL_OK, "src/a.ts", { startLine: 2, endLine: 2 });
    expect(res.content).toBe("line2");
    expect(res.startLine).toBe(2);
    expect(res.totalLines).toBeGreaterThanOrEqual(3);
  });

  it("rejects ../ traversal and symlink escape", async () => {
    const { c, dir, root } = setup();
    writeFileSync(join(root, "secret.txt"), "top secret");
    await expect(c.readFile(URL_OK, "../secret.txt")).rejects.toBeInstanceOf(GitError);
    symlinkSync(join(root, "secret.txt"), join(dir, "sneaky.txt"));
    await expect(c.readFile(URL_OK, "sneaky.txt")).rejects.toBeInstanceOf(GitError);
  });

  it("rejects binary files", async () => {
    const { c, dir } = setup();
    writeFileSync(join(dir, "bin.dat"), Buffer.from([0x89, 0x00, 0x01]));
    await expect(c.readFile(URL_OK, "bin.dat")).rejects.toBeInstanceOf(GitError);
  });

  it("throws GitError for a missing file", async () => {
    const { c } = setup();
    await expect(c.readFile(URL_OK, "src/missing.ts")).rejects.toBeInstanceOf(GitError);
  });
});

describe("GitRepoClient history", () => {
  it("parses tab-separated log output", async () => {
    const log =
      "abc\t2026-07-01T10:00:00+02:00\tJane\tfix: rounding\ndef\t2026-06-30T09:00:00+02:00\tBob\tfeat: pay v2";
    const exec: ExecFn = vi.fn(async (_f, args) =>
      args.includes("log") ? { stdout: log, stderr: "" } : { stdout: "abc123\n", stderr: "" }
    );
    const c = new GitRepoClient(ADO, exec, () => true);
    const res = await c.history(URL_OK, { maxCount: 2 });
    expect(res.commits).toHaveLength(2);
    expect(res.commits[0]).toEqual({
      sha: "abc",
      date: "2026-07-01T10:00:00+02:00",
      author: "Jane",
      subject: "fix: rounding"
    });
  });
});
