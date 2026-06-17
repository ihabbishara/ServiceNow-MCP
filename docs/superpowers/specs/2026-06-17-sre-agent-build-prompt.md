# SRE Agent — End-to-End Build Prompt

Paste the block below as the goal for a fresh Claude Code session (or the cloud ultraplan once the
GitHub app is installed on the repo). Companion design spec:
`docs/superpowers/specs/2026-06-17-sre-agent-copilot-sdk-design.md`.

---

```text
GOAL: Build "sre-agent" — a standalone SRE chatbot that reuses our existing ServiceNow + Azure DevOps
tooling, driven by the official GitHub Copilot SDK (Copilot seat auth). Our org blocked MCP servers in
Copilot AND bans Azure DevOps PATs, so we repackage the functionality as a Copilot-SDK app whose custom
tools are NOT MCP (not blocked), and we access Azure DevOps via the `az boards` CLI (az login, no PAT).
Copilot CLI is confirmed working in this org.

REPO: /Users/ihabbishara/projects/ServiceNowMCP  (existing MCP server lives in MCP/)
DESIGN SPEC (read first): docs/superpowers/specs/2026-06-17-sre-agent-copilot-sdk-design.md

NON-NEGOTIABLE CONTEXT (researched & verified 2026-06-17 — do NOT re-litigate):
- LLM runtime = official GitHub Copilot SDK, npm "@github/copilot-sdk" (GA, semver-stable 1.0.x, MIT,
  Node ^20.19 || >=22.12). Bundles the "@github/copilot" runtime over JSON-RPC — NO separate Copilot CLI
  install at deploy time. Pin the version; never install the "unstable" dist-tag.
- Custom tools (defineTool) are a DIFFERENT mechanism from MCP servers (session fields: `tools` vs
  `mcpServers`). The org MCP block does not touch custom tools. Use defineTool, never MCP.
- Default auth = Copilot seat: `new CopilotClient()` auto-detects the logged-in `copilot` CLI /
  COPILOT_GITHUB_TOKEN. Fallback = BYOK via per-session `provider` config (Azure OpenAI/Anthropic);
  BYOK requires explicit `model`. Azure footgun: native *.openai.azure.com → type:"azure" (host only);
  Foundry /openai/v1/ → type:"openai".
- Verified Copilot SDK API:
    import { CopilotClient, defineTool, approveAll } from "@github/copilot-sdk";
    const client = new CopilotClient(); await client.start();
    const tool = defineTool("name", { description, parameters: zodSchema, handler: async (args)=>result, skipPermission?: true });
    const session = await client.createSession({ model, tools:[...], streaming:true, onPermissionRequest });
    session.on("assistant.message_delta", e => process.stdout.write(e.data.deltaContent));
    session.on("tool.execution_start"/"tool.execution_complete", ...);
    session.on("session.idle", () => /* turn done */);
    await session.send({ prompt });  // or session.sendAndWait(prompt)
    await session.abort();           // Ctrl-C
  onPermissionRequest(request) returns {kind:"approve-once"} | {kind:"reject", feedback}; branch on
  request.kind === "custom-tool" && request.toolName.
- Azure DevOps access = `az boards` CLI (azure-devops extension), auth via `az login` (Microsoft Entra),
  NO PAT. Verified facts:
    * Install: `az extension add --name azure-devops` (self-installs first run; min 2.30.0).
    * Auth: with an active `az login` session the extension uses the Entra token — do NOT set
      AZURE_DEVOPS_EXT_PAT and do NOT use `az devops login` (that stores a PAT). Cloud-only (not ADO
      Server). Guest/B2B identities are forced to PAT. Unattended SP/managed-identity is NOT cleanly
      documented — out of scope for v1 (interactive `az login` only).
    * Read single: `az boards work-item show --id <n> --expand fields --output json --only-show-errors`.
    * Read many: NO `work-item list`; use `az boards query --wiql "SELECT [System.Id],[System.Title],
      [System.State],[System.AssignedTo],[System.AreaPath],[System.IterationPath],[System.Tags],
      [System.WorkItemType] FROM workitems WHERE <filters> ORDER BY [System.ChangedDate] DESC"`.
      Query RETURNS FULLY-HYDRATED items (no follow-up show); caps at 1000.
      Filters: [System.WorkItemType]='User Story'|'Task'|'Bug', [System.State]='Active', [System.AreaPath]
      UNDER 'Proj\\Team', [System.AssignedTo]=@Me|'user@x', [System.Title] CONTAINS 'text'. @Me follows
      the az login user.
    * Create (gated write, same auth): `az boards work-item create --type Bug --title <t> --area <a>
      --iteration <i> --fields "ref=value ..."` (create/update use SPACE-separated field=value; show's
      --fields is COMMA-separated names — don't mix them up).
    * JSON shape (VERIFIED live 2026-06-17 against org INGCDaaS/project IngOne): response is
      { id, rev, url, fields:{...}, relations:[...], multilineFieldsFormat:{...} }. Read `fields` by
      bracket access (dotted keys). MAP TO A SLIM WorkItem — never return the raw blob (avatars, _links,
      descriptors, WEF_* Kanban fields, HTML bodies, relations[] will burn model context). Slim fields:
      System.Id, System.Title, System.WorkItemType, System.State, System.AreaPath, System.IterationPath,
      Microsoft.VSTS.Common.Priority (number), Microsoft.VSTS.Scheduling.StoryPoints, System.Parent, url.
      System.AssignedTo is a FAT OBJECT → .uniqueName ?? .displayName, and may be ABSENT (unassigned).
      System.Tags may be ABSENT; when present it's "a; b" → split /;\s*/. System.Description /
      Microsoft.VSTS.Common.AcceptanceCriteria / System.History are HTML (per multilineFieldsFormat) →
      strip tags if surfaced. System.AreaPath uses single backslash (JSON \\) e.g. IngOne\P33421-PSSSRE —
      preserve it in WIQL UNDER filters. getWorkItem uses --expand fields to skip heavy relations[].
    * Run hygiene: pass --org <ORG_URL> (+ --project <PROJECT> where supported; `work-item show` takes
      only --org). Gate success on EXIT CODE 0 (az writes warnings to stderr even on success); use
      --only-show-errors to keep stdout pure JSON. `az` spawn is ~0.3–2s — prefer one query over N shows.

ARCHITECTURE (locked):
1. Convert the repo to an npm WORKSPACES monorepo:
   - packages/core  = shared brains: clients/, services/, config.ts, types.ts, runtime.ts + the existing
     47 tests. ServiceNow/ADO behavior must NOT change.
   - packages/mcp-server = current MCP adapter (tools/resources/prompts) importing @sre/core (kept alive
     as a hedge for when MCP is unblocked).
   - packages/sre-agent = NEW Copilot-SDK chatbot importing @sre/core.
2. Refactor the ADO layer in core: `AzureDevOpsClient` becomes an INTERFACE (searchWorkItems, createBug,
   NEW getWorkItem). Two impls: AdoPatClient (existing REST+PAT, renamed, kept for portability) and
   AzBoardsClient (NEW, default) shelling out via an `AzRunner` helper (child_process.execFile("az",...),
   always --output json --only-show-errors + explicit --org/--project; resolve on exit 0, throw on
   non-zero with stderr). Select impl by ADO_AUTH_MODE. Extend the WorkItem type with workItemType.
3. sre-agent layout: src/tools (12 defineTool wrappers), src/engine (CopilotClient lifecycle + streaming
   + permission gate, FRONT-END-AGNOSTIC), src/workflows (4 commands), src/cli (REPL v1 surface),
   src/config.ts, src/index.ts (bin).
4. Map the tools to defineTool, reusing existing zod schemas + model-tuned descriptions VERBATIM. The 11
   read tools get skipPermission:true. New: get_work_item (show by id); extend search_work_items
   (query_text optional + add state/type/area/assigned_to filters → WIQL). create_bug_from_incident
   (write) is gated and routes through `az boards work-item create` when ADO_AUTH_MODE=azcli.
5. Write gate: onPermissionRequest intercepts toolName "create_bug_from_incident" → front-end
   confirm(summary) (terminal y/N) → approve-once | reject(feedback). Honors ADO_CREATE_BUG_ENABLED +
   new CONFIRM_WRITES (default true).
6. Workflows /triage <INC>, /handover <team> [hours], /review <CHG>, /postmortem <INC> port the existing
   prompt templates from prompts/index.ts verbatim and seed the session; no new logic.
7. New config (zod, fail-fast): LLM_MODE (seat|byok, default seat), LLM_MODEL (default gpt-5),
   LLM_PROVIDER, LLM_BASE_URL, LLM_API_KEY, AZURE_API_VERSION (2024-10-21), CONFIRM_WRITES (true),
   ADO_AUTH_MODE (azcli|pat, default azcli), AZ_PATH (default "az"). azcli requires ADO_ORG_URL +
   ADO_PROJECT (NOT ADO_PAT) and a working az login session (checked by preflight). byok requires
   LLM_MODEL + provider block.
8. Preflight/doctor (azcli + a /doctor command): verify `az` on PATH, azure-devops extension present,
   `az account show` succeeds → fail fast with "run `az login`" instead of an opaque mid-chat error.

BUILD ORDER (verify each before moving on):
- M0: workspace extraction; @sre/core + @sre/mcp-server build; ALL 47 tests green; MCP server still runs.
- M1: sre-agent skeleton; CopilotClient hello-world on the seat; one tool wired; REPL streams an answer.
- M2a: AzBoardsClient + AzRunner in core behind the AzureDevOpsClient interface; ADO_AUTH_MODE switch;
       getWorkItem + WIQL searchWorkItems; preflight; unit tests green (fake AzRunner — assert exact argv,
       fields parsing incl. absent assignee + tag split, exit-code handling).
- M2b: all 12 tools wired into sre-agent + permission gate on the write (approve runs az create, reject
       doesn't).
- M3: 4 workflow commands.
- M4: BYOK fallback + config hardening + README/USAGE.
- (M5 later, separate spec: Slack adapter over the same engine.)

METHOD:
- TDD: for each tool wrapper, AzBoardsClient method, and the permission gate, write the failing test
  against a fake runtime / fake AzRunner first, watch it fail, implement, watch it pass.
- Tool handlers wrap errors as { error: string } so failures are recoverable, never crash the session.
- WIQL injection safety: reuse escapeWiql (double single quotes) on all interpolated filter values;
  validate work-item ids as integers before shelling out.
- Do not break the MCP server; its tests stay green after extraction.
- Engine tested with a stubbed CopilotClient (tools registered, prompt sent, idle resolves, deltas
  forwarded). Seat e2e and az-boards e2e are manual smokes (need a live seat / live az login) — document
  the manual steps.

ACCEPTANCE (done = all true):
- `npm test` green across the workspace (core 47 + AzBoardsClient + tool/gate/engine tests).
- mcp-server still builds and starts (regression-free extraction).
- With ADO_AUTH_MODE=azcli and a live `az login`: "show work item 1234", "list active user stories for
  <area>", "what tasks are assigned to me" all return real data via az boards.
- On a live Copilot seat: "what's at SLA risk for <team>?", "summarize INC0012345", "/handover <team>",
  and "create a bug for INC0012345" work; the bug-create prompts for y/N and only writes (via az boards)
  on yes.
- Flipping LLM_MODE=byok with Azure OpenAI creds runs the same flows with zero code changes.
- README/USAGE explain setup, the seat-vs-BYOK toggle, ADO_AUTH_MODE, the az login requirement, and the
  manual e2e smokes.

CONSTRAINTS: TypeScript/ESM matching the existing code (thin handlers, logic in services, honest tool
descriptions). Secrets via env. Stdout reserved for chat output; logs + az stderr warnings to stderr.
Validate the no-PAT `az login → az boards` path live for THIS org/identity before relying on it (older
extension versions / guest accounts can fail). Ask before any irreversible action.
```
