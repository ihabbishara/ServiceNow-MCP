# Git Repo Capability + Code Analyser Sub-Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the agent check out an Azure DevOps git repo tied to an incident and pinpoint root-cause code locations, via 4 shared repo tools plus a Code Analyser sub-agent in the sre-agent package.

**Architecture:** A read-only `GitRepoClient` (core) shells out to `git` via `execFile`, restricted to the configured ADO org. Four new tool specs in the single-source `TOOL_SPECS` registry expose it on both surfaces (MCP server registers registries generically — zero mcp-server changes). A `code_analysis` prompt spec joins `PROMPT_SPECS`. In sre-agent, `ChatEngine.runSubAgent` opens a second Copilot session with a restricted toolset; an `analyze_code` tool delegates to it.

**Tech Stack:** TypeScript ESM monorepo, zod v4, vitest, `@github/copilot-sdk`, `git` CLI via `node:child_process.execFile`.

**Spec:** `docs/superpowers/specs/2026-07-06-git-repo-code-analyser-design.md`

## Global Constraints

- All git invocations use `execFile` argv arrays — never a shell string.
- Repo URLs must be `https:` and inside the configured ADO org (`dev.azure.com/<org>` or `<org>.visualstudio.com`); anything else is rejected. PAT is passed per-invocation via `http.extraHeader`, never embedded in the URL, and redacted from all error messages.
- No mutating remote git operations anywhere (no push/commit).
- New tools are read-class: `write` unset → no permission gate; `enabledWhen` gates on `c.azureDevOps.orgUrl`.
- Expected failures: core client throws `GitError`; tool specs map it to `ToolError`. Copilot adapter contract: handlers return `{ error }`, never throw.
- Run all commands from repo root `/Users/ihabbishara/projects/ServiceNowMCP`.
- Every task ends with lint-clean code: `npx eslint <changed files>` before commit.

---

### Task 1: Config — `GIT_WORKSPACE_DIR`

**Files:**
- Modify: `packages/core/src/config.ts` (envSchema ~line 93, `AdoConfig` ~line 104, `buildAppConfig` azureDevOps block ~line 253)
- Modify: `packages/sre-agent/.env.example`
- Modify: `packages/core/tests/env-example.test.ts` (REQUIRED_DOCUMENTED array)
- Test: `packages/core/tests/config.test.ts`

**Interfaces:**
- Produces: `AdoConfig.gitWorkspaceDir?: string` (undefined when env unset). Later tasks read it from `config.azureDevOps.gitWorkspaceDir`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/tests/config.test.ts` inside the `describe("loadConfig", ...)` block:

```ts
  it("parses GIT_WORKSPACE_DIR into azureDevOps.gitWorkspaceDir", () => {
    const cfg = loadConfig({ ...validEnv, GIT_WORKSPACE_DIR: "/var/tmp/repos" });
    expect(cfg.azureDevOps.gitWorkspaceDir).toBe("/var/tmp/repos");
  });

  it("leaves gitWorkspaceDir undefined when GIT_WORKSPACE_DIR is unset or empty", () => {
    expect(loadConfig(validEnv).azureDevOps.gitWorkspaceDir).toBeUndefined();
    expect(
      loadConfig({ ...validEnv, GIT_WORKSPACE_DIR: "" }).azureDevOps.gitWorkspaceDir
    ).toBeUndefined();
  });
```

Also add `"GIT_WORKSPACE_DIR"` to the `REQUIRED_DOCUMENTED` array in `packages/core/tests/env-example.test.ts`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/core/tests/config.test.ts packages/core/tests/env-example.test.ts`
Expected: FAIL — `gitWorkspaceDir` undefined vs "/var/tmp/repos"; `.env.example` missing `GIT_WORKSPACE_DIR`.

- [ ] **Step 3: Implement**

In `packages/core/src/config.ts`:

1. envSchema — after the `SHAREPOINT_TIMEOUT_MS` line add:

```ts
  GIT_WORKSPACE_DIR: optional(z.string().min(1))
```

2. `AdoConfig` — after `csvMaxBytes: number;` add:

```ts
  /** Root dir for incident-analysis repo checkouts (GIT_WORKSPACE_DIR); default under os.tmpdir(). */
  gitWorkspaceDir?: string;
```

3. `buildAppConfig` azureDevOps block — after `csvMaxBytes: e.ADO_CSV_MAX_BYTES` add:

```ts
      gitWorkspaceDir: e.GIT_WORKSPACE_DIR
```

In `packages/sre-agent/.env.example`, next to the other ADO vars add:

```
# Root directory for git checkouts used by the repo analysis tools (default: OS temp dir)
# GIT_WORKSPACE_DIR=/var/tmp/sre-agent-repos
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/core/tests/config.test.ts packages/core/tests/env-example.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/config.ts packages/core/tests/config.test.ts packages/core/tests/env-example.test.ts packages/sre-agent/.env.example
git commit -m "feat(core): GIT_WORKSPACE_DIR config for repo analysis checkouts"
```

---

### Task 2: GitRepoClient — read-only git wrapper

**Files:**
- Create: `packages/core/src/clients/git.ts`
- Modify: `packages/core/src/index.ts` (add export)
- Test: `packages/core/tests/clients/git.test.ts`

**Interfaces:**
- Consumes: `AdoConfig` (Task 1), `ExecFn` from `packages/core/src/clients/ado/az.ts`.
- Produces (used by Task 3):
  - `class GitError extends Error`
  - `repoDirFor(url: string, ref: string | undefined, root: string): string`
  - `class GitRepoClient`:
    - `constructor(ado: Pick<AdoConfig, "orgUrl" | "pat" | "gitWorkspaceDir">, exec?: ExecFn, exists?: (p: string) => boolean)`
    - `ensureRepo(rawUrl: string, ref?: string): Promise<{ dir: string; headSha: string; branch: string; reused: boolean }>`
    - `grep(rawUrl: string, pattern: string, opts?: { ref?: string; glob?: string }): Promise<{ matches: { file: string; line: number; text: string }[]; truncated: boolean }>`
    - `readFile(rawUrl: string, relPath: string, opts?: { ref?: string; startLine?: number; endLine?: number }): Promise<{ path: string; startLine: number; endLine: number; totalLines: number; content: string; truncated: boolean }>`
    - `history(rawUrl: string, opts?: { ref?: string; path?: string; maxCount?: number }): Promise<{ commits: { sha: string; date: string; author: string; subject: string }[] }>`

- [ ] **Step 1: Write the failing tests**

Create `packages/core/tests/clients/git.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitRepoClient, GitError, repoDirFor } from "../../src/clients/git.js";
import type { ExecFn } from "../../src/clients/ado/az.js";

const ADO = { orgUrl: "https://dev.azure.com/INGCDaaS", pat: undefined, gitWorkspaceDir: undefined };
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
    await expect(c.ensureRepo("https://dev.azure.com/ingcdaas/IngOne/_git/payments")).resolves.toBeTruthy();
    await expect(c.ensureRepo("https://INGCDaaS.visualstudio.com/IngOne/_git/payments")).resolves.toBeTruthy();
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
      throw Object.assign(new Error("boom"), { stderr: `fatal: auth ${pat} / Basic ${b64} rejected` });
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
    expect(res.matches[0]).toEqual({ file: "src/pay.ts", line: 42, text: "  throw new PaymentError()" });
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
    const log = "abc\t2026-07-01T10:00:00+02:00\tJane\tfix: rounding\ndef\t2026-06-30T09:00:00+02:00\tBob\tfeat: pay v2";
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/core/tests/clients/git.test.ts`
Expected: FAIL — `Cannot find module '../../src/clients/git.js'`

- [ ] **Step 3: Implement `packages/core/src/clients/git.ts`**

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile as fsReadFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import type { ExecFn } from "./ado/az.js";
import type { AdoConfig } from "../config.js";

/** Expected, user-facing git failure; the repo tool specs map it to ToolError. */
export class GitError extends Error {}

export interface RepoInfo {
  dir: string;
  headSha: string;
  branch: string;
  reused: boolean;
}
export interface GrepResult {
  matches: { file: string; line: number; text: string }[];
  truncated: boolean;
}
export interface FileSlice {
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  content: string;
  truncated: boolean;
}
export interface CommitInfo {
  sha: string;
  date: string;
  author: string;
  subject: string;
}

// git is a real binary on every platform (unlike az.cmd), so plain execFile —
// argv array, no shell — is safe and sufficient.
const execFileP = promisify(execFile) as unknown as ExecFn;

const MAX_GREP_MATCHES = 200;
const MAX_FILE_BYTES = 64 * 1024;

/** Deterministic per-(url, ref) checkout directory under the workspace root. */
export const repoDirFor = (url: string, ref: string | undefined, root: string): string => {
  const key = createHash("sha1").update(`${url}#${ref ?? ""}`).digest("hex").slice(0, 10);
  const name = (basename(new URL(url).pathname) || "repo").replace(/[^a-zA-Z0-9._-]/g, "-");
  return join(root, `${name}-${key}`);
};

/**
 * Read-only git wrapper for incident code analysis. Clones are restricted to
 * the configured Azure DevOps organization: this blocks prompt-injected clone
 * targets from incident text and guarantees the PAT header is never sent to a
 * foreign host. No mutating remote operation exists on this client.
 */
export class GitRepoClient {
  constructor(
    private readonly ado: Pick<AdoConfig, "orgUrl" | "pat" | "gitWorkspaceDir">,
    private readonly exec: ExecFn = execFileP,
    private readonly exists: (p: string) => boolean = existsSync
  ) {}

  private orgName(): string {
    if (!this.ado.orgUrl) throw new GitError("Azure DevOps is not configured (ADO_ORG_URL).");
    const u = new URL(this.ado.orgUrl);
    if (u.hostname.toLowerCase() === "dev.azure.com") {
      const seg = u.pathname.split("/").filter(Boolean)[0];
      if (seg) return seg;
    }
    const m = u.hostname.toLowerCase().match(/^([^.]+)\.visualstudio\.com$/);
    if (m) return m[1];
    throw new GitError(`cannot derive organization from ADO_ORG_URL: ${this.ado.orgUrl}`);
  }

  /** Allow ONLY https URLs inside the configured org; strip embedded credentials. */
  private validateUrl(raw: string): string {
    let u: URL;
    try {
      u = new URL(raw.trim());
    } catch {
      throw new GitError(`not a valid repo URL: ${raw}`);
    }
    if (u.protocol !== "https:") throw new GitError("only https repo URLs are supported");
    u.username = "";
    u.password = "";
    const org = this.orgName().toLowerCase();
    const host = u.hostname.toLowerCase();
    const firstSeg = u.pathname.split("/").filter(Boolean)[0]?.toLowerCase();
    const ok = (host === "dev.azure.com" && firstSeg === org) || host === `${org}.visualstudio.com`;
    if (!ok) {
      throw new GitError(
        "repo URL must be in the configured Azure DevOps organization " +
          `(expected https://dev.azure.com/${this.orgName()}/<project>/_git/<repo>)`
      );
    }
    return u.href;
  }

  /** PAT travels per-invocation via extraHeader — never in the URL (would persist in .git/config). */
  private authArgs(): string[] {
    if (!this.ado.pat) return [];
    const b64 = Buffer.from(`:${this.ado.pat}`).toString("base64");
    return ["-c", `http.extraHeader=Authorization: Basic ${b64}`];
  }

  private redact(s: string): string {
    if (!this.ado.pat) return s;
    const b64 = Buffer.from(`:${this.ado.pat}`).toString("base64");
    return s.split(this.ado.pat).join("***").split(b64).join("***");
  }

  private async run(label: string, args: string[]): Promise<string> {
    try {
      const { stdout } = await this.exec("git", args, {
        timeout: 120000,
        maxBuffer: 16 * 1024 * 1024
      });
      return stdout;
    } catch (err: unknown) {
      const e = err as { stderr?: string; message?: string };
      const msg = (e?.stderr || e?.message || String(err)).toString();
      throw new GitError(`git ${label} failed: ${this.redact(msg).slice(0, 300)}`);
    }
  }

  private workspaceRoot(): string {
    return this.ado.gitWorkspaceDir ?? join(tmpdir(), "sre-agent-repos");
  }

  async ensureRepo(rawUrl: string, ref?: string): Promise<RepoInfo> {
    const url = this.validateUrl(rawUrl);
    const dir = repoDirFor(url, ref, this.workspaceRoot());
    const reused = this.exists(join(dir, ".git"));
    if (!reused) {
      // ponytail: shallow depth-50 clone; an existing checkout is reused as-is
      // (no refetch) — pass a ref or clear GIT_WORKSPACE_DIR to force fresh code.
      await this.run("clone", [
        ...this.authArgs(),
        "clone",
        "--depth",
        "50",
        ...(ref ? ["--branch", ref] : []),
        url,
        dir
      ]);
    }
    const headSha = (await this.run("rev-parse", ["-C", dir, "rev-parse", "HEAD"])).trim();
    const branch = (
      await this.run("rev-parse", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"])
    ).trim();
    return { dir, headSha, branch, reused };
  }

  async grep(
    rawUrl: string,
    pattern: string,
    opts: { ref?: string; glob?: string } = {}
  ): Promise<GrepResult> {
    const { dir } = await this.ensureRepo(rawUrl, opts.ref);
    let stdout: string;
    try {
      const res = await this.exec(
        "git",
        [
          "-C",
          dir,
          "grep",
          "-n",
          "-I",
          "--no-color",
          "-e",
          pattern,
          ...(opts.glob ? ["--", opts.glob] : [])
        ],
        { timeout: 60000, maxBuffer: 16 * 1024 * 1024 }
      );
      stdout = res.stdout;
    } catch (err: unknown) {
      const e = err as { code?: number; stderr?: string; message?: string };
      if (e?.code === 1) return { matches: [], truncated: false }; // exit 1 = no matches
      throw new GitError(
        `git grep failed: ${this.redact((e?.stderr || e?.message || String(err)).toString()).slice(0, 300)}`
      );
    }
    const lines = stdout.split("\n").filter(Boolean);
    const matches = lines.slice(0, MAX_GREP_MATCHES).flatMap((l) => {
      const m = l.match(/^([^:]+):(\d+):(.*)$/s);
      return m ? [{ file: m[1], line: Number(m[2]), text: m[3] }] : [];
    });
    return { matches, truncated: lines.length > MAX_GREP_MATCHES };
  }

  async readFile(
    rawUrl: string,
    relPath: string,
    opts: { ref?: string; startLine?: number; endLine?: number } = {}
  ): Promise<FileSlice> {
    const { dir } = await this.ensureRepo(rawUrl, opts.ref);
    const rootReal = await realpath(dir);
    let fileReal: string;
    try {
      fileReal = await realpath(resolve(dir, relPath));
    } catch {
      throw new GitError(`file not found: ${relPath}`);
    }
    // realpath-based containment: catches both ../ traversal and symlink escape.
    if (fileReal !== rootReal && !fileReal.startsWith(rootReal + sep)) {
      throw new GitError(`path escapes the repository: ${relPath}`);
    }
    const buf = await fsReadFile(fileReal);
    if (buf.includes(0)) throw new GitError(`binary file: ${relPath}`);
    const allLines = buf.toString("utf8").split("\n");
    const start = Math.max(1, opts.startLine ?? 1);
    const end = Math.min(allLines.length, opts.endLine ?? allLines.length);
    let content = allLines.slice(start - 1, end).join("\n");
    let truncated = false;
    if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
      content = Buffer.from(content, "utf8").subarray(0, MAX_FILE_BYTES).toString("utf8");
      truncated = true;
    }
    return { path: relPath, startLine: start, endLine: end, totalLines: allLines.length, content, truncated };
  }

  async history(
    rawUrl: string,
    opts: { ref?: string; path?: string; maxCount?: number } = {}
  ): Promise<{ commits: CommitInfo[] }> {
    const { dir } = await this.ensureRepo(rawUrl, opts.ref);
    const n = Math.min(Math.max(opts.maxCount ?? 20, 1), 100);
    const out = await this.run("log", [
      "-C",
      dir,
      "log",
      `--max-count=${n}`,
      "--date=iso-strict",
      "--pretty=format:%H%x09%ad%x09%an%x09%s",
      ...(opts.path ? ["--", opts.path] : [])
    ]);
    const commits = out
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [sha, date, author, ...rest] = l.split("\t");
        return { sha, date, author, subject: rest.join("\t") };
      });
    return { commits };
  }
}
```

Add to `packages/core/src/index.ts` after the ado exports (line 7):

```ts
export * from "./clients/git.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/core/tests/clients/git.test.ts`
Expected: PASS (all describes)

- [ ] **Step 5: Lint and commit**

```bash
npx eslint packages/core/src/clients/git.ts packages/core/tests/clients/git.test.ts packages/core/src/index.ts
git add packages/core/src/clients/git.ts packages/core/tests/clients/git.test.ts packages/core/src/index.ts
git commit -m "feat(core): read-only GitRepoClient with org allowlist and PAT redaction"
```

---

### Task 3: Runtime wiring + 4 repo tool specs

**Files:**
- Modify: `packages/core/src/runtime.ts` (McpRuntime interface + createMcpRuntime)
- Create: `packages/core/src/tools/specs/repo.ts`
- Modify: `packages/core/src/tools/registry.ts` (import + spread)
- Test: `packages/core/tests/tools/repo.test.ts`

**Interfaces:**
- Consumes: `GitRepoClient`, `GitError` (Task 2); `AdoConfig.gitWorkspaceDir` (Task 1).
- Produces:
  - `McpRuntime.gitRepos?: GitRepoClient` (present when `config.azureDevOps.orgUrl` set)
  - Tools in `TOOL_SPECS`: `checkout_repo`, `search_repo`, `read_repo_file`, `repo_history` — schemas/returns below; Task 6 relies on these exact names.

- [ ] **Step 1: Write the failing tests**

Create `packages/core/tests/tools/repo.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { TOOL_SPECS, ToolError } from "../../src/tools/registry.js";
import { GitError } from "../../src/clients/git.js";
import type { McpRuntime } from "../../src/runtime.js";
import type { AppConfig } from "../../src/config.js";

const spec = (n: string) => TOOL_SPECS.find((s) => s.name === n)!;
const REPO_TOOLS = ["checkout_repo", "search_repo", "read_repo_file", "repo_history"];

const fakeGit = () => ({
  ensureRepo: vi.fn(async () => ({ dir: "/x", headSha: "abc", branch: "main", reused: false })),
  grep: vi.fn(async () => ({ matches: [], truncated: false })),
  readFile: vi.fn(async () => ({
    path: "a.ts", startLine: 1, endLine: 1, totalLines: 1, content: "x", truncated: false
  })),
  history: vi.fn(async () => ({ commits: [] }))
});

const rt = (git?: ReturnType<typeof fakeGit>) => ({ gitRepos: git }) as unknown as McpRuntime;
const cfgWith = (orgUrl?: string) => ({ azureDevOps: { orgUrl } }) as unknown as AppConfig;

describe("repo tool specs", () => {
  it("registers all four repo tools as read-class", () => {
    for (const n of REPO_TOOLS) {
      expect(spec(n), n).toBeDefined();
      expect(spec(n).write, n).toBeFalsy();
    }
  });

  it("enabledWhen requires azureDevOps.orgUrl", () => {
    for (const n of REPO_TOOLS) {
      expect(spec(n).enabledWhen!(cfgWith("https://dev.azure.com/Org"))).toBeNull();
      expect(spec(n).enabledWhen!(cfgWith(undefined))).toMatch(/ADO_ORG_URL/);
    }
  });

  it("throws ToolError when the runtime has no git client", async () => {
    await expect(
      spec("checkout_repo").run(rt(undefined), { repo_url: "https://x" })
    ).rejects.toBeInstanceOf(ToolError);
  });

  it("checkout_repo returns headSha/branch/reused and NOT the local dir", async () => {
    const git = fakeGit();
    const res = await spec("checkout_repo").run(rt(git), {
      repo_url: "https://dev.azure.com/Org/P/_git/r", ref: "main"
    });
    expect(res).toEqual({ headSha: "abc", branch: "main", reused: false });
    expect(git.ensureRepo).toHaveBeenCalledWith("https://dev.azure.com/Org/P/_git/r", "main");
  });

  it("search_repo / read_repo_file / repo_history pass args through", async () => {
    const git = fakeGit();
    await spec("search_repo").run(rt(git), {
      repo_url: "u", pattern: "PaymentError", glob: "src/**", ref: "r"
    });
    expect(git.grep).toHaveBeenCalledWith("u", "PaymentError", { ref: "r", glob: "src/**" });

    await spec("read_repo_file").run(rt(git), {
      repo_url: "u", path: "src/a.ts", start_line: 5, end_line: 9
    });
    expect(git.readFile).toHaveBeenCalledWith("u", "src/a.ts", {
      ref: undefined, startLine: 5, endLine: 9
    });

    await spec("repo_history").run(rt(git), { repo_url: "u", path: "src/a.ts", max_count: 5 });
    expect(git.history).toHaveBeenCalledWith("u", { ref: undefined, path: "src/a.ts", maxCount: 5 });
  });

  it("maps GitError to ToolError with the same message; other errors rethrow as-is", async () => {
    const git = fakeGit();
    git.ensureRepo.mockRejectedValueOnce(new GitError("bad url"));
    const err = await spec("checkout_repo").run(rt(git), { repo_url: "u" }).catch((e) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as Error).message).toBe("bad url");

    git.ensureRepo.mockRejectedValueOnce(new RangeError("bug"));
    await expect(spec("checkout_repo").run(rt(git), { repo_url: "u" })).rejects.toBeInstanceOf(RangeError);
  });
});
```

If TypeScript complains about the `run(...)` argument types (the widened `ToolSpec` erases the schema), cast the args object `as never` — match whatever style `packages/core/tests/tools/registry.test.ts` already uses for `spec(n).run(...)` calls.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/core/tests/tools/repo.test.ts`
Expected: FAIL — `spec("checkout_repo")` undefined.

- [ ] **Step 3: Implement**

Create `packages/core/src/tools/specs/repo.ts`:

```ts
import { z } from "zod";
import { ToolError, defineSpec } from "../spec.js";
import { GitError } from "../../clients/git.js";
import type { GitRepoClient } from "../../clients/git.js";
import type { McpRuntime } from "../../runtime.js";

const DISABLED_MSG =
  "Git repo tools require Azure DevOps to be configured (set ADO_ORG_URL).";

const gitClient = (rt: McpRuntime): GitRepoClient => {
  // Defense in depth: enabledWhen gates on config, this guards a runtime without the client.
  if (!rt.gitRepos) throw new ToolError(DISABLED_MSG);
  return rt.gitRepos;
};

/** GitError is an expected user-facing failure → ToolError; anything else rethrows. */
const mapGitError = async <T>(p: Promise<T>): Promise<T> => {
  try {
    return await p;
  } catch (err) {
    if (err instanceof GitError) throw new ToolError(err.message);
    throw err;
  }
};

const repoUrl = z
  .string()
  .describe("Azure DevOps repo clone URL, e.g. https://dev.azure.com/<org>/<project>/_git/<repo>");
const ref = z
  .string()
  .optional()
  .describe("Branch or tag to analyse (default: the repo's default branch)");

export const repoSpecs = [
  defineSpec({
    name: "checkout_repo",
    description:
      "Shallow-clone (or reuse) an Azure DevOps git repository into the local analysis workspace. " +
      "If the repo URL is unknown, ask the user for it in the format " +
      "https://dev.azure.com/<org>/<project>/_git/<repo>. Run before search_repo / read_repo_file / repo_history.",
    schema: { repo_url: repoUrl, ref },
    enabledWhen: (c) => (c.azureDevOps.orgUrl ? null : DISABLED_MSG),
    run: async (rt, a) => {
      const { headSha, branch, reused } = await mapGitError(
        gitClient(rt).ensureRepo(a.repo_url, a.ref)
      );
      // Local checkout path is an implementation detail; the URL is the handle.
      return { headSha, branch, reused };
    }
  }),
  defineSpec({
    name: "search_repo",
    description:
      "Search a repo's tracked files with git grep. Use symbols, function names, or distinctive " +
      "error-message fragments extracted from incident stack traces. Returns file:line matches (max 200).",
    schema: {
      repo_url: repoUrl,
      pattern: z.string().min(1).describe("Text or regex (POSIX basic) to search for"),
      glob: z.string().optional().describe("Limit to a pathspec, e.g. 'src/**/*.ts'"),
      ref
    },
    enabledWhen: (c) => (c.azureDevOps.orgUrl ? null : DISABLED_MSG),
    run: (rt, a) => mapGitError(gitClient(rt).grep(a.repo_url, a.pattern, { ref: a.ref, glob: a.glob }))
  }),
  defineSpec({
    name: "read_repo_file",
    description:
      "Read a file (or a line range) from a checked-out repo. Use after search_repo to inspect the " +
      "code around a match. Text files only, capped at 64KB.",
    schema: {
      repo_url: repoUrl,
      path: z.string().min(1).describe("Repo-relative file path, e.g. src/payments/charge.ts"),
      start_line: z.coerce.number().int().positive().optional().describe("First line (1-based, inclusive)"),
      end_line: z.coerce.number().int().positive().optional().describe("Last line (1-based, inclusive)"),
      ref
    },
    enabledWhen: (c) => (c.azureDevOps.orgUrl ? null : DISABLED_MSG),
    run: (rt, a) =>
      mapGitError(
        gitClient(rt).readFile(a.repo_url, a.path, {
          ref: a.ref,
          startLine: a.start_line,
          endLine: a.end_line
        })
      )
  }),
  defineSpec({
    name: "repo_history",
    description:
      "Recent commit history for a repo or a specific file within it. Recent changes to a suspect " +
      "file are prime root-cause candidates. History is limited by the shallow clone depth (50).",
    schema: {
      repo_url: repoUrl,
      path: z.string().optional().describe("Repo-relative path to scope the log to"),
      max_count: z.coerce.number().int().positive().max(100).optional().describe("Commits to return (default 20)"),
      ref
    },
    enabledWhen: (c) => (c.azureDevOps.orgUrl ? null : DISABLED_MSG),
    run: (rt, a) =>
      mapGitError(gitClient(rt).history(a.repo_url, { ref: a.ref, path: a.path, maxCount: a.max_count }))
  })
];
```

In `packages/core/src/tools/registry.ts`: add import and spread (after `workItemCsvSpecs`):

```ts
import { repoSpecs } from "./specs/repo.js";
```

```ts
export const TOOL_SPECS: ToolSpec[] = [
  ...incidentSpecs,
  ...changeSpecs,
  ...analysisSpecs,
  ...knowledgeSpecs,
  ...sharePointSpecs,
  ...adoSpecs,
  ...workItemCsvSpecs,
  ...repoSpecs
];
```

In `packages/core/src/runtime.ts`:

1. Import: `import { GitRepoClient } from "./clients/git.js";`
2. `McpRuntime` interface — after `workItemService: WorkItemService;` add:

```ts
  /** Present when azureDevOps.orgUrl is configured; backs the repo analysis tools. */
  gitRepos?: GitRepoClient;
```

3. In `createMcpRuntime`, after the `sharePoint` const:

```ts
  const gitRepos = config.azureDevOps.orgUrl ? new GitRepoClient(config.azureDevOps) : undefined;
```

and add `gitRepos` to the returned object.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/core/tests/tools/repo.test.ts packages/core/tests/tools/registry.test.ts packages/core/tests/runtime.test.ts`
Expected: PASS — including the existing registry invariants (unique names, description length) now covering the 4 new tools.

- [ ] **Step 5: Lint and commit**

```bash
npx eslint packages/core/src/tools/specs/repo.ts packages/core/src/tools/registry.ts packages/core/src/runtime.ts packages/core/tests/tools/repo.test.ts
git add packages/core/src/tools/specs/repo.ts packages/core/src/tools/registry.ts packages/core/src/runtime.ts packages/core/tests/tools/repo.test.ts
git commit -m "feat(core): repo tool specs (checkout/search/read/history) + runtime git client"
```

---

### Task 4: `code_analysis` prompt spec

**Files:**
- Modify: `packages/core/src/prompts/registry.ts` (append to `PROMPT_SPECS`)
- Test: `packages/core/tests/prompts/registry.test.ts`

**Interfaces:**
- Produces: `promptSpec("code_analysis").build({ repo_url, error_text, incident_number?, ref? })` — Task 6's `analyze_code` builds the sub-agent prompt from this.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/tests/prompts/registry.test.ts`:

```ts
describe("code_analysis prompt", () => {
  it("embeds the repo URL, error text, ref, and incident and names the repo tools", () => {
    const text = promptSpec("code_analysis").build({
      repo_url: "https://dev.azure.com/Org/P/_git/pay",
      error_text: "TypeError: Cannot read properties of undefined at charge (charge.ts:42)",
      incident_number: "INC0012345",
      ref: "release/1.2"
    });
    expect(text).toContain("https://dev.azure.com/Org/P/_git/pay");
    expect(text).toContain("charge.ts:42");
    expect(text).toContain("release/1.2");
    expect(text).toContain("INC0012345");
    for (const tool of ["checkout_repo", "search_repo", "read_repo_file", "repo_history"]) {
      expect(text).toContain(tool);
    }
    expect(text).toContain("## Suspects");
    expect(text).toContain("## Confidence");
  });

  it("omits incident/ref lines when not provided", () => {
    const text = promptSpec("code_analysis").build({
      repo_url: "https://dev.azure.com/Org/P/_git/pay",
      error_text: "boom"
    });
    expect(text).not.toContain("Incident:");
    expect(text).not.toContain("ref:");
  });
});
```

(Match the file's existing import style — it already imports `promptSpec`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/core/tests/prompts/registry.test.ts`
Expected: FAIL — `unknown prompt: code_analysis`

- [ ] **Step 3: Implement**

Append to the `PROMPT_SPECS` array in `packages/core/src/prompts/registry.ts` (after `incident_postmortem`), and update the array's doc comment from "The four workflow prompts" to "The workflow prompts":

```ts
  definePromptSpec({
    name: "code_analysis",
    description: "Pinpoint likely root-cause code locations for an incident's error output",
    schema: {
      repo_url: z
        .string()
        .describe("Azure DevOps repo clone URL (https://dev.azure.com/<org>/<project>/_git/<repo>)"),
      error_text: z.string().describe("Error messages / stack traces to analyse"),
      incident_number: z.string().optional().describe("Related incident, e.g. INC0012345"),
      ref: z.string().optional().describe("Branch or tag matching the deployed version")
    },
    build: (a) => `You are a Code Analyser. Pinpoint where in the codebase the failure below most likely originates.

Repository: ${a.repo_url}${a.ref ? ` (ref: ${a.ref})` : ""}${
      a.incident_number
        ? `\nIncident: ${a.incident_number} — call get_incident for more context if needed.`
        : ""
    }

Error output to analyse:
\`\`\`
${a.error_text}
\`\`\`

Method:
1. Call checkout_repo for the repository${a.ref ? " at the given ref" : ""}.
2. Extract file names, class/function symbols, and line numbers from the error output.
3. Call search_repo for each symbol or distinctive message fragment.
4. Call read_repo_file around the matches to understand the failing code path.
5. Call repo_history on the suspect files — recent changes are prime suspects.

Report exactly these sections:
## Suspects — file:line list, one line each, with why it is suspect
## Hypothesis — the most likely failure mechanism
## Evidence — code and commit facts supporting the hypothesis
## Suggested fix area — where a fix would land (do not write the fix)
## Confidence — high / medium / low, with the main remaining uncertainty

Ground every claim in tool output. Never invent file contents or line numbers.`
  })
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/core/tests/prompts/registry.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
npx eslint packages/core/src/prompts/registry.ts packages/core/tests/prompts/registry.test.ts
git add packages/core/src/prompts/registry.ts packages/core/tests/prompts/registry.test.ts
git commit -m "feat(core): code_analysis prompt spec (single source for MCP prompt + sub-agent)"
```

---

### Task 5: Engine — `runSubAgent` + code-analysis steering instruction

**Files:**
- Modify: `packages/sre-agent/src/engine/engine.ts`
- Test: `packages/sre-agent/tests/engine.test.ts`

**Interfaces:**
- Consumes: existing `ChatEngine`, `SessionConfig`, fake-client seam in tests.
- Produces (Task 6 relies on these):
  - `CODE_ANALYSIS_SYSTEM_INSTRUCTION: string` (exported const)
  - `ChatEngine.runSubAgent(opts: { tools: Tool<any>[]; prompt: string }): Promise<string>`

- [ ] **Step 1: Write the failing tests**

In `packages/sre-agent/tests/engine.test.ts`, extend `makeFakeSession` so `sendAndWait` can emit deltas through whatever handler `.on("assistant.message_delta", …)` registered:

```ts
const makeFakeSession = (deltas: string[] = []) => {
  const handlers: Record<string, (e: { data: { deltaContent: string } }) => void> = {};
  const session = {
    on: vi.fn((event: string, cb: (e: { data: { deltaContent: string } }) => void) => {
      handlers[event] = cb;
      return vi.fn();
    }),
    sendAndWait: vi.fn(async () => {
      for (const d of deltas) handlers["assistant.message_delta"]?.({ data: { deltaContent: d } });
      return undefined;
    }),
    disconnect: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined)
  };
  return session;
};
```

Update `makeFakeClient` so each `createSession` call returns a NEW session, and the sub-agent one streams deltas:

```ts
const makeFakeClient = (
  authStatus = { isAuthenticated: true, login: "octocat", authType: "user" as const },
  subAgentDeltas: string[] = []
) => {
  const sessions: ReturnType<typeof makeFakeSession>[] = [];
  const createSession = vi.fn(async (_config: SessionConfig) => {
    // first session = main chat (no deltas needed); later ones stream subAgentDeltas
    const s = makeFakeSession(sessions.length === 0 ? [] : subAgentDeltas);
    sessions.push(s);
    return s;
  });
  const getAuthStatus = vi.fn(async () => authStatus);
  const client = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => [] as Error[]),
    getAuthStatus,
    createSession
  };
  return { client, createSession, getAuthStatus, sessions };
};
```

**IMPORTANT:** existing tests destructure `session` from `makeFakeClient()` — update them to use `sessions[0]` (check each usage; the test file is the only consumer).

Add the new describes:

```ts
describe("ChatEngine.runSubAgent", () => {
  it("creates a second session with ONLY the given tools, returns accumulated deltas, disconnects", async () => {
    const { client, createSession, sessions } = makeFakeClient(undefined, ["## Suspects\n", "- a.ts:42"]);
    const config = loadAgentConfig({ ...base });
    const engine = new ChatEngine({ config, tools: [], ...noopDeps, clientFactory: () => client as never });
    await engine.start();

    const subTools = [{ name: "checkout_repo" }, { name: "get_incident" }] as never[];
    const report = await engine.runSubAgent({ tools: subTools, prompt: "analyse this" });

    expect(report).toBe("## Suspects\n- a.ts:42");
    expect(createSession).toHaveBeenCalledTimes(2);
    const subConfig = createSession.mock.calls[1][0];
    expect(subConfig.tools).toBe(subTools);
    expect(subConfig.model).toBe(config.llm.model);
    expect(sessions[1].sendAndWait).toHaveBeenCalledWith("analyse this", config.turnTimeoutMs);
    expect(sessions[1].disconnect).toHaveBeenCalledOnce();
    expect(sessions[0].disconnect).not.toHaveBeenCalled(); // main session untouched
  });

  it("throws before start()", async () => {
    const config = loadAgentConfig({ ...base });
    const engine = new ChatEngine({ config, tools: [], ...noopDeps });
    await expect(engine.runSubAgent({ tools: [], prompt: "x" })).rejects.toThrow(/not started/);
  });

  it("disconnects the sub-session even when sendAndWait rejects", async () => {
    const { client, sessions } = makeFakeClient();
    const config = loadAgentConfig({ ...base });
    const engine = new ChatEngine({ config, tools: [], ...noopDeps, clientFactory: () => client as never });
    await engine.start();
    // sessions[1] is created inside runSubAgent; make its sendAndWait reject after creation:
    const p = engine.runSubAgent({ tools: [], prompt: "x" });
    await Promise.resolve(); // let createSession resolve
    sessions[1].sendAndWait.mockRejectedValueOnce(new Error("timeout"));
    await expect(p).rejects.toThrow(); // and assert disconnect ran:
    expect(sessions[1].disconnect).toHaveBeenCalledOnce();
  });
});

describe("CODE_ANALYSIS_SYSTEM_INSTRUCTION", () => {
  it("is appended when ADO org is configured", async () => {
    const { client, createSession } = makeFakeClient();
    const config = loadAgentConfig({ ...base }); // base includes ADO_ORG_URL
    const engine = new ChatEngine({ config, tools: [], ...noopDeps, clientFactory: () => client as never });
    await engine.start();
    const sc = createSession.mock.calls[0][0];
    expect(sc.systemMessage?.content).toContain("analyze_code");
    expect(sc.systemMessage?.content).toContain("_git/");
  });

  it("is absent when ADO org is not configured", async () => {
    const { client, createSession } = makeFakeClient();
    const noAdo = { ...base } as Record<string, string>;
    delete noAdo.ADO_ORG_URL;
    delete noAdo.ADO_PROJECT;
    const config = loadAgentConfig(noAdo);
    const engine = new ChatEngine({ config, tools: [], ...noopDeps, clientFactory: () => client as never });
    await engine.start();
    const sc = createSession.mock.calls[0][0];
    expect(sc.systemMessage?.content ?? "").not.toContain("analyze_code");
  });
});
```

Note on the timing-sensitive third test: if `mockRejectedValueOnce` after `Promise.resolve()` proves flaky, simplify by making the fake's `sendAndWait` reject unconditionally for sub-sessions constructed with `makeFakeSession()` and a `rejectWith` param — the deliverable is only "disconnect runs on failure".

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/sre-agent/tests/engine.test.ts`
Expected: new tests FAIL (`runSubAgent is not a function`, missing instruction); pre-existing tests PASS after the fake refactor. Fix any fake-refactor fallout FIRST so only the genuinely-new assertions fail.

- [ ] **Step 3: Implement in `packages/sre-agent/src/engine/engine.ts`**

1. Add the exported instruction next to the other two:

```ts
/** Appended when ADO is configured: steer toward analyze_code for code root-cause requests. */
export const CODE_ANALYSIS_SYSTEM_INSTRUCTION =
  "This agent has an `analyze_code` tool that checks out an Azure DevOps git repository and pinpoints " +
  "likely root-cause code locations for an incident's error output. When an incident contains stack " +
  "traces or error messages referencing application code and the user wants a root cause, first ask " +
  "the user for the repo clone URL in the format https://dev.azure.com/<org>/<project>/_git/<repo> " +
  "(and optionally the deployed branch/tag), then call `analyze_code` with that URL and the error text. " +
  "Relay the analyser's report and cite the suspect file:line locations.";
```

2. In `start()`, extend the instructions array:

```ts
      const systemInstructions = [
        cfg.knowledgeEnabled ? KNOWLEDGE_SYSTEM_INSTRUCTION : null,
        cfg.sharePointEnabled ? SHAREPOINT_SYSTEM_INSTRUCTION : null,
        cfg.app.azureDevOps.orgUrl ? CODE_ANALYSIS_SYSTEM_INSTRUCTION : null
      ].filter(Boolean);
```

3. Extract the BYOK provider block (currently inline in `start()`'s `sessionConfig`) into a private method, and use it in both places:

```ts
  /** BYOK provider block for a SessionConfig; empty object in seat mode. */
  private providerConfig(): Partial<SessionConfig> {
    const cfg = this.deps.config;
    return cfg.llm.mode === "byok" && cfg.llm.provider
      ? {
          provider: {
            type: cfg.llm.provider.type,
            baseUrl: cfg.llm.provider.baseUrl,
            apiKey: cfg.llm.provider.apiKey,
            ...(cfg.llm.provider.type === "azure"
              ? { azure: { apiVersion: cfg.llm.provider.apiVersion } }
              : {})
          }
        }
      : {};
  }
```

In `start()`, replace the inline `...(cfg.llm.mode === "byok" ...)` spread with `...this.providerConfig()`.

4. Add the method:

```ts
  /**
   * Run a one-shot sub-agent: a second session on the same client with a
   * restricted toolset. Deltas are not streamed to the UI; they accumulate and
   * the final text returns. The sub-session is disconnected afterwards; the
   * main session is untouched.
   */
  async runSubAgent(opts: { tools: Tool<any>[]; prompt: string }): Promise<string> {
    if (!this.client) throw new Error("engine not started");
    const cfg = this.deps.config;
    const session = await this.client.createSession({
      model: cfg.llm.model,
      streaming: true,
      tools: opts.tools,
      // Sub-agent toolset is read-only; deny anything that asks for permission.
      onPermissionRequest: async () => ({
        kind: "reject" as const,
        feedback: "Sub-agent tools are read-only."
      }),
      ...this.providerConfig()
    });
    const chunks: string[] = [];
    const offDelta = session.on("assistant.message_delta", (e) =>
      chunks.push(e.data.deltaContent)
    );
    const offTool = session.on("tool.execution_start", (e) =>
      this.deps.onToolStart?.(e.data.toolName)
    );
    try {
      await session.sendAndWait(opts.prompt, cfg.turnTimeoutMs);
    } finally {
      offDelta();
      offTool();
      await session.disconnect().catch(() => undefined);
    }
    return chunks.join("");
  }
```

If `PermissionHandler`'s reject shape differs (check `permissions.ts`: it returns `{ kind: "reject", feedback }`), match it exactly.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/sre-agent/tests/engine.test.ts`
Expected: PASS — all pre-existing + new.

- [ ] **Step 5: Lint and commit**

```bash
npx eslint packages/sre-agent/src/engine/engine.ts packages/sre-agent/tests/engine.test.ts
git add packages/sre-agent/src/engine/engine.ts packages/sre-agent/tests/engine.test.ts
git commit -m "feat(sre-agent): ChatEngine.runSubAgent + code-analysis steering instruction"
```

---

### Task 6: `analyze_code` tool + CLI wiring

**Files:**
- Create: `packages/sre-agent/src/tools/analyzeCode.ts`
- Modify: `packages/sre-agent/src/cli/index.ts` (engine construction, ~line 187)
- Test: `packages/sre-agent/tests/analyze-code.test.ts`

**Interfaces:**
- Consumes: `promptSpec("code_analysis")` (Task 4), `TOOL_SPECS` + `toCopilotTool` (existing, `packages/sre-agent/src/tools/index.ts`), `ChatEngine.runSubAgent` (Task 5), tool names from Task 3.
- Produces: `buildAnalyzeCodeTool(runtime: McpRuntime, getEngine: () => ChatEngine): Tool` — Copilot tool named `analyze_code`.

- [ ] **Step 1: Write the failing tests**

Create `packages/sre-agent/tests/analyze-code.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import type { McpRuntime } from "@sre/core";
import { buildAnalyzeCodeTool, CODE_ANALYSER_TOOL_NAMES } from "../src/tools/analyzeCode.js";
import type { ChatEngine } from "../src/engine/engine.js";

// The handler only maps specs to tools and delegates; a bare runtime stub suffices.
const runtime = { config: {} } as unknown as McpRuntime;

const makeEngine = (impl?: () => Promise<string>) =>
  ({ runSubAgent: vi.fn(impl ?? (async () => "THE REPORT")) }) as unknown as ChatEngine;

const call = (tool: ReturnType<typeof buildAnalyzeCodeTool>, args: object) =>
  (tool.handler as (a: object) => Promise<object>)(args);

describe("analyze_code tool", () => {
  it("delegates to runSubAgent with the restricted toolset and the code_analysis prompt", async () => {
    const engine = makeEngine();
    const tool = buildAnalyzeCodeTool(runtime, () => engine);
    const res = await call(tool, {
      repo_url: "https://dev.azure.com/Org/P/_git/pay",
      error_text: "TypeError at charge.ts:42",
      incident_number: "INC0012345"
    });
    expect(res).toEqual({ report: "THE REPORT" });

    const { tools, prompt } = (engine.runSubAgent as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(new Set(tools.map((t: { name: string }) => t.name))).toEqual(
      new Set(CODE_ANALYSER_TOOL_NAMES)
    );
    expect(prompt).toContain("https://dev.azure.com/Org/P/_git/pay");
    expect(prompt).toContain("TypeError at charge.ts:42");
    expect(prompt).toContain("INC0012345");
  });

  it("returns { error } instead of throwing when the sub-agent fails", async () => {
    const engine = makeEngine(async () => {
      throw new Error("sub-agent timeout");
    });
    const tool = buildAnalyzeCodeTool(runtime, () => engine);
    const res = await call(tool, { repo_url: "u", error_text: "e" });
    expect(res).toEqual({ error: "sub-agent timeout" });
  });

  it("the restricted toolset is exactly repo tools + get_incident", () => {
    expect([...CODE_ANALYSER_TOOL_NAMES].sort()).toEqual(
      ["checkout_repo", "get_incident", "read_repo_file", "repo_history", "search_repo"].sort()
    );
  });
});
```

If existing `tests/tools.test.ts` invokes handlers differently (e.g. a second context arg), copy that file's invocation pattern instead of `call` above.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/sre-agent/tests/analyze-code.test.ts`
Expected: FAIL — module `../src/tools/analyzeCode.js` not found.

- [ ] **Step 3: Implement**

Create `packages/sre-agent/src/tools/analyzeCode.ts`:

```ts
import { defineTool } from "@github/copilot-sdk";
import { z } from "zod";
import { TOOL_SPECS, promptSpec } from "@sre/core";
import type { McpRuntime } from "@sre/core";
import { toCopilotTool } from "./index.js";
import type { ChatEngine } from "../engine/engine.js";

/** The Code Analyser's restricted toolset: repo primitives + incident context. */
export const CODE_ANALYSER_TOOL_NAMES = [
  "checkout_repo",
  "search_repo",
  "read_repo_file",
  "repo_history",
  "get_incident"
] as const;

/**
 * Copilot tool that delegates code root-cause analysis to a Code Analyser
 * sub-agent (a second session with only the repo tools + get_incident). The
 * main chat receives the analyser's report, never the raw code context.
 * `getEngine` is a lazy ref: the engine is constructed with this tool in its
 * toolset, so the reference resolves only at call time.
 */
export const buildAnalyzeCodeTool = (runtime: McpRuntime, getEngine: () => ChatEngine) =>
  defineTool("analyze_code", {
    description:
      "Delegate code root-cause analysis to the Code Analyser sub-agent. Provide the Azure DevOps " +
      "repo clone URL (ask the user for it: https://dev.azure.com/<org>/<project>/_git/<repo>), the " +
      "incident's error text / stack traces, and optionally the deployed branch or tag. Returns a " +
      "report with suspect file:line locations, hypothesis, evidence, and confidence.",
    skipPermission: true,
    parameters: z.object({
      repo_url: z.string().describe("Azure DevOps repo clone URL"),
      error_text: z.string().describe("Error messages / stack traces from the incident"),
      incident_number: z.string().optional().describe("Related incident number, e.g. INC0012345"),
      ref: z.string().optional().describe("Branch or tag matching the deployed version")
    }),
    handler: async (args) => {
      try {
        const prompt = promptSpec("code_analysis").build(args);
        const tools = TOOL_SPECS.filter((s) =>
          (CODE_ANALYSER_TOOL_NAMES as readonly string[]).includes(s.name)
        ).map((s) => toCopilotTool(s, runtime));
        const report = await getEngine().runSubAgent({ tools, prompt });
        return { report };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    }
  });
```

In `packages/sre-agent/src/cli/index.ts`:

1. Import: `import { buildAnalyzeCodeTool } from "../tools/analyzeCode.js";`
2. Replace the engine construction (~line 187):

```ts
  // analyze_code needs the engine (to spawn its sub-session) and the engine
  // needs the full toolset at construction — a lazy ref breaks the cycle.
  let engineRef: ChatEngine | undefined;
  const engine = new ChatEngine({
    config,
    tools: [
      ...buildTools(runtime),
      buildAnalyzeCodeTool(runtime, () => {
        if (!engineRef) throw new Error("engine not started");
        return engineRef;
      })
    ],
    confirm,
    onDelta: (t) => stdout.write(t),
    onToolStart: (n) => stdout.write(`\n  ↳ ${n}…\n`)
  });
  engineRef = engine;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run packages/sre-agent/tests/analyze-code.test.ts packages/sre-agent/tests/tools.test.ts`
Expected: PASS

- [ ] **Step 5: Lint and commit**

```bash
npx eslint packages/sre-agent/src/tools/analyzeCode.ts packages/sre-agent/src/cli/index.ts packages/sre-agent/tests/analyze-code.test.ts
git add packages/sre-agent/src/tools/analyzeCode.ts packages/sre-agent/src/cli/index.ts packages/sre-agent/tests/analyze-code.test.ts
git commit -m "feat(sre-agent): analyze_code tool delegating to Code Analyser sub-agent"
```

---

### Task 7: Full verification

**Files:** none new — whole-workspace gates.

- [ ] **Step 1: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: clean exit.

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: all packages green. If any pre-existing test asserts tool/prompt counts or snapshots of `TOOL_SPECS`/`PROMPT_SPECS`, update it to include the 4 new tools / 1 new prompt.

- [ ] **Step 3: Lint + format**

Run: `npm run lint && npm run format:check`
Expected: clean. Run `npm run format` if format:check fails, then re-verify.

- [ ] **Step 4: Commit any fixups**

```bash
git add -A
git commit -m "chore: verification fixups for git repo capability" # only if fixups exist
```
