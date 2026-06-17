# @sre/sre-agent

A standalone CLI chatbot for the ServiceNow / Azure DevOps SRE tooling, built on
the official [GitHub Copilot SDK](https://www.npmjs.com/package/@github/copilot-sdk)
with custom tools (`defineTool`) over `@sre/core`.

> Status: **Milestone 1 skeleton** — a REPL that connects to Copilot, registers
> one real tool (`get_incident`), and streams an answer. More tools, workflows,
> the `az boards` ADO path, and the write-permission gate land in later milestones.

## Run

```bash
npm run build --workspace @sre/sre-agent
npm run dev --workspace @sre/sre-agent   # tsx, no build needed
# or, after build:
node packages/sre-agent/dist/cli/index.js
```

Type a question (e.g. `get me INC0012345`) at the `>` prompt. `Ctrl-C` aborts the
current turn; an empty line or `/exit` quits.

## Required environment (manual smoke)

The CLI fails fast with a clear configuration error if required env is missing.

Agent config (`loadAgentConfig`) + core config (`createMcpRuntime`) read:

| Variable               | Required        | Default      | Notes                                            |
| ---------------------- | --------------- | ------------ | ------------------------------------------------ |
| `SERVICENOW_BASE_URL`  | yes             | —            | e.g. `https://acme.service-now.com`              |
| `SERVICENOW_USERNAME`  | yes             | —            |                                                  |
| `SERVICENOW_PASSWORD`  | yes             | —            |                                                  |
| `ADO_ORG_URL`          | yes (azcli)     | —            | e.g. `https://dev.azure.com/INGCDaaS`            |
| `ADO_PROJECT`          | yes (azcli)     | —            | e.g. `IngOne`                                    |
| `ADO_AUTH_MODE`        | no              | `azcli`      | `azcli` (no-PAT) or `pat`                        |
| `LLM_MODE`             | no              | `seat`       | `seat` (Copilot seat auth) or `byok`             |
| `LLM_MODEL`            | no              | `gpt-5`      |                                                  |
| `LLM_PROVIDER`         | byok only       | —            | `azure` \| `anthropic` \| `openai`               |
| `LLM_BASE_URL`         | byok only       | —            | BYOK endpoint URL                                |
| `LLM_API_KEY`          | byok            | —            | BYOK key (optional for local providers)          |
| `CONFIRM_WRITES`       | no              | `true`       | confirm before write tools (later milestone)     |

The live Copilot-seat smoke (actually chatting through a seat) requires a valid
Copilot seat available to `@github/copilot-sdk` and live ServiceNow credentials,
and is a **manual** step — it is not run by the automated test suite.

### Manual smoke checklist

1. Export the ServiceNow + ADO env above (seat mode needs no `LLM_*` overrides).
2. Ensure a Copilot seat is available to the SDK (it auto-detects seat auth).
3. `npm run dev --workspace @sre/sre-agent`
4. Ask `get me INC0012345` — expect a streamed answer with a `↳ get_incident…`
   tool-activity line.
