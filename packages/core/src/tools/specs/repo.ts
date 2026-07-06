import { z } from "zod";
import { ToolError, defineSpec } from "../spec.js";
import { GitError } from "../../clients/git.js";
import type { GitRepoClient } from "../../clients/git.js";
import type { McpRuntime } from "../../runtime.js";

const DISABLED_MSG = "Git repo tools require Azure DevOps to be configured (set ADO_ORG_URL).";

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
    run: (rt, a) =>
      mapGitError(gitClient(rt).grep(a.repo_url, a.pattern, { ref: a.ref, glob: a.glob }))
  }),
  defineSpec({
    name: "read_repo_file",
    description:
      "Read a file (or a line range) from a checked-out repo. Use after search_repo to inspect the " +
      "code around a match. Text files only, capped at 64KB.",
    schema: {
      repo_url: repoUrl,
      path: z.string().min(1).describe("Repo-relative file path, e.g. src/payments/charge.ts"),
      start_line: z.coerce
        .number()
        .int()
        .positive()
        .optional()
        .describe("First line (1-based, inclusive)"),
      end_line: z.coerce
        .number()
        .int()
        .positive()
        .optional()
        .describe("Last line (1-based, inclusive)"),
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
      max_count: z.coerce
        .number()
        .int()
        .positive()
        .max(100)
        .optional()
        .describe("Commits to return (default 20)"),
      ref
    },
    enabledWhen: (c) => (c.azureDevOps.orgUrl ? null : DISABLED_MSG),
    run: (rt, a) =>
      mapGitError(
        gitClient(rt).history(a.repo_url, { ref: a.ref, path: a.path, maxCount: a.max_count })
      )
  })
];
