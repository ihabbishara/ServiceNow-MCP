# Git Repo Capability + Code Analyser Sub-Agent — Design

**Date:** 2026-07-06
**Status:** Approved

## Problem

During incident triage the agent sees stack traces and error messages that
reference application code, but it has no way to look at that code. The user
wants the agent to check out the relevant git repository and pinpoint where in
the code the failure likely originates — preferably delegated to a dedicated
"Code Analyser" agent so the main triage conversation is not flooded with raw
code context.

## Decisions (from brainstorming)

- **Git host:** Azure DevOps Repos only. Reuses the existing ADO org + PAT
  configuration; no new credential surface.
- **Repo discovery:** the user supplies the repo URL. The agent must be
  *proactive*: when an incident contains code-referencing errors, it asks the
  user for the repo clone URL and states the expected format
  (`https://dev.azure.com/<org>/<project>/_git/<repo>`). No config mapping, no
  CMDB dependency.
- **Shape:** Approach A — repo primitive tools live in the shared core tool
  registry (both MCP server and sre-agent surfaces get them), and a Code
  Analyser **sub-agent** in the sre-agent package drives them in an isolated
  session.

## Architecture

### 1. Git client — `packages/core/src/clients/git.ts`

A thin, read-only wrapper around the `git` binary.

- `ensureRepo(url, ref?)` → `{ dir, headSha, branch }`
  - **Host allowlist:** the URL must point at the configured ADO organization
    (`https://dev.azure.com/<org>/…` or `https://<org>.visualstudio.com/…`).
    Anything else is rejected with a `ToolError`. This blocks prompt-injection
    attempts embedded in incident text ("clone https://evil.example/x") and
    guarantees the PAT can never be sent to a foreign host.
  - Shallow clone (`--depth 50`) into a per-repo directory under the workspace
    root; if the directory already exists, `fetch` + `checkout` instead.
    Optional `ref` (branch / tag / commit) so analysis can match the deployed
    version.
  - **Workspace root:** `GIT_WORKSPACE_DIR` env var, defaulting to a directory
    under `os.tmpdir()`. Tmpdir doubles as the GC policy — no custom cleanup.
  - **Auth:** when an ADO PAT is configured, it is passed per-invocation via
    `-c http.extraHeader=Authorization: Basic <base64(:PAT)>` — never embedded
    in the remote URL (that would persist the PAT in `.git/config`). Without a
    PAT, plain clone (ambient git credential helper may cover it).
  - All git invocations use `execFile` (argv array, no shell) — same command
    injection posture as the winQuote fix.
  - The client exposes **no mutating remote operations** (no push, no commit).

### 2. Repo tool specs — `packages/core/src/tools/specs/repo.ts`

Four new specs registered in `TOOL_SPECS` (single-source registry → MCP server
and sre-agent both expose them):

| tool | args | behaviour |
|---|---|---|
| `checkout_repo` | `repo_url`, `ref?` | ensureRepo; returns headSha + branch. Stateless: the URL is the handle for the other tools. |
| `search_repo` | `repo_url`, `pattern`, `glob?` | `git grep -n` inside the checkout; output capped (~200 matching lines) with a truncation notice. |
| `read_repo_file` | `repo_url`, `path`, `start_line?`, `end_line?` | reads a file inside the repo. Realpath-prefix containment check (no `../` escape, no symlink escape). ~64 KB cap. |
| `repo_history` | `repo_url`, `path?`, `max_count?` | `git log` (optionally scoped to a path) — recent-change context for suspect files. |

- All four are **read-class** tools (they mutate local scratch disk only, not
  external state) → `write: false`, no permission gate.
- `enabledWhen`: requires the ADO org to be configured (same gate style as the
  other conditional tools).
- Failures surface as `ToolError` with the PAT **redacted** from any git
  stderr included in messages.

### 3. Prompt spec — `code_analysis` in core `PROMPT_SPECS`

Follows the P1c single-source prompt pattern. Args: `repo_url`, `error_text`,
`incident_number?`. Body instructs the analyser to:

1. `checkout_repo` (honouring any ref the user gave),
2. extract symbols / file names / line numbers from the error text,
3. `search_repo` for those symbols,
4. `read_repo_file` around the hits,
5. `repo_history` on suspect files (recent changes are prime suspects),
6. report: suspect `file:line` list, failure hypothesis, supporting evidence,
   suggested fix area, confidence level.

MCP hosts get this as a registered prompt; the sre-agent sub-agent builds its
session from the same spec — the two surfaces cannot drift.

### 4. Code Analyser sub-agent — `packages/sre-agent`

- `ChatEngine.runSubAgent({ systemMessage, tools, prompt })` — creates a
  **second session** on the already-running `CopilotClient` (same model +
  provider config), accumulates `assistant.message_delta` events,
  `sendAndWait` with the configured `turnTimeoutMs`, disposes the session,
  returns the accumulated report text.
- `analyze_code` tool — sre-agent-only (defined with the Copilot `defineTool`,
  appended to the `buildTools(runtime)` output in the CLI wiring; it is *not*
  in the core registry because it needs a Copilot session). Params:
  `repo_url`, `error_text`, `incident_number?`. Handler = `runSubAgent` with:
  - system/user prompt built from the `code_analysis` prompt spec,
  - a **restricted tool set**: the four repo tools + `get_incident` only.
- `CODE_ANALYSIS_SYSTEM_INSTRUCTION` — appended to the main session's system
  message (same pattern as the knowledge / SharePoint instructions), gated on
  the feature being enabled: when incident text contains stack traces or error
  messages referencing code and the user wants root cause, **ask the user for
  the repo clone URL, stating the expected format**
  `https://dev.azure.com/<org>/<project>/_git/<repo>`, then call
  `analyze_code`. The main chat receives only the analyser's report, never the
  raw code context.

### 5. Data flow

```
user:  /triage INC0012345
agent: get_incident → sees stack trace
agent: "Which repo? Format: https://dev.azure.com/<org>/<project>/_git/<repo>"
user:  <url>
agent: analyze_code(url, error_text)
          └─► Code Analyser session:
                checkout_repo → search_repo(symbols) → read_repo_file → repo_history
          ◄── report: suspect file:line, hypothesis, evidence, confidence
agent: triage summary + root-cause pinpoint
```

## Configuration

- Reuses existing `AdoConfig` (org, PAT, az-cli mode untouched — git ops use
  the PAT when present).
- New optional env: `GIT_WORKSPACE_DIR` (checkout root; default under tmpdir).
- Feature enablement derives from ADO org presence — no separate flag.

## Error handling

`ToolError` for: URL host not in allowlist, clone/fetch failure (trimmed
stderr, PAT redacted), unknown ref, file not found, path containment
violation, binary/oversized file (truncated with notice). Sub-agent errors
return `{ error }` to the main model per the existing adapter contract — a
failed analysis never kills the triage turn.

## Testing

- **Git client:** unit tests with a fake `execFile` runner (existing client
  test style): host allowlist accept/reject, PAT header injection + redaction,
  clone-vs-fetch branch, ref checkout.
- **Repo tools:** tool-level tests per existing `tests/tools` pattern:
  containment guard, output caps, enabledWhen gating.
- **Sub-agent:** engine test via the existing `clientFactory` fake seam —
  assert second-session creation, restricted toolset, report passthrough,
  disposal; `analyze_code` handler test with a stubbed `runSubAgent`.

## Out of scope (deliberate)

- Repo indexing / embeddings — `git grep` + LLM reasoning is sufficient.
- GitHub / other hosts — ADO only.
- Clone GC / eviction — tmpdir semantics.
- Any write operation on repos (branch, commit, push, PR).
