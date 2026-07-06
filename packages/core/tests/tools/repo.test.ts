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
