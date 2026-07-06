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
  const key = createHash("sha1")
    .update(`${url}#${ref ?? ""}`)
    .digest("hex")
    .slice(0, 10);
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
    return {
      path: relPath,
      startLine: start,
      endLine: end,
      totalLines: allLines.length,
      content,
      truncated
    };
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
