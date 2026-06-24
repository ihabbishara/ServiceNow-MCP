# @sre/sre-agent

A standalone CLI chatbot for the ServiceNow / Azure DevOps SRE tooling, built on
the official [GitHub Copilot SDK](https://www.npmjs.com/package/@github/copilot-sdk)
with custom tools (`defineTool`) over [`@sre/core`](../core).

It is a thin REPL front-end: it connects to Copilot (a seat by default, or a
BYOK provider), registers 12 custom tools (11 read tools + one gated write),
exposes four workflow slash-commands, and streams the model's answer to your
terminal.

## What it does

- **Reads ServiceNow** — incidents, changes, SLA risk, stale tickets, daily ops
  summary, and change correlation.
- **Reads Azure DevOps** — work-item search and single-item lookup, by default
  with **no PAT** via the `az boards` CLI.
- **One write, gated** — `create_bug_from_incident` creates an ADO bug from an
  incident and is the only tool that prompts for confirmation (y/N).
- **Workflows** — `/triage`, `/review`, `/postmortem`, `/handover` expand into
  seed prompts; anything else is sent to the model verbatim.

## Setup

1. `npm install` at the repo root (workspaces install `@github/copilot-sdk` and
   link `@sre/core`).
2. **A working Copilot seat** for the default seat mode — the SDK auto-detects
   seat auth from your environment (e.g. an authenticated `copilot`/`gh` login).
   No seat? Use the BYOK fallback below.
3. **`az login`** — required when `ADO_AUTH_MODE=azcli` (the default). The agent
   shells out to the Azure CLI with no PAT; it runs a preflight (`az account
   show`) on startup and tells you to `az login` if the session is not
   authenticated. Install the `azure-devops` extension if prompted.
4. Configure environment — copy [`.env.example`](./.env.example) and fill it in.
   The CLI **fails fast** with a clear configuration error if required variables
   are missing.

## Run

```bash
npm run build --workspace @sre/sre-agent
npm run dev --workspace @sre/sre-agent   # tsx, no build needed
# or, after build:
node packages/sre-agent/dist/cli/index.js
```

At the `>` prompt, ask a question (e.g. `summarize INC0012345`) or use a
workflow command (`/help` lists them). `Ctrl-C` aborts the current turn; press
it again — or send an empty line / `/exit` — to quit.

## Configuration

Every variable, with safe placeholders and one-line comments, lives in
[`.env.example`](./.env.example). The highlights:

| Variable               | Required        | Default        | Notes                                            |
| ---------------------- | --------------- | -------------- | ------------------------------------------------ |
| `SERVICENOW_BASE_URL`  | yes             | —              | e.g. `https://acme.service-now.com`              |
| `SERVICENOW_USERNAME`  | yes             | —              |                                                  |
| `SERVICENOW_PASSWORD`  | yes             | —              | secret                                           |
| `ADO_AUTH_MODE`        | no              | `azcli`        | `azcli` (no-PAT) or `pat`                        |
| `ADO_ORG_URL`          | yes (azcli)     | —              | e.g. `https://dev.azure.com/INGCDaaS`            |
| `ADO_PROJECT`          | yes (azcli)     | —              | e.g. `IngOne`                                    |
| `ADO_PAT`              | yes (pat)       | —              | secret; only when `ADO_AUTH_MODE=pat`            |
| `LLM_MODE`             | no              | `seat`         | `seat` (Copilot seat) or `byok`                  |
| `LLM_MODEL`            | no              | `gpt-5`        | model id / BYOK deployment name                  |
| `LLM_PROVIDER`         | yes (byok)      | —              | `azure` \| `anthropic` \| `openai`               |
| `LLM_BASE_URL`         | yes (byok)      | —              | BYOK endpoint URL                                |
| `LLM_API_KEY`          | byok            | —              | secret; optional for local providers (Ollama)   |
| `AZURE_API_VERSION`    | no              | `2024-10-21`   | Azure OpenAI `api-version` (azure provider only) |
| `CONFIRM_WRITES`       | no              | `true`         | y/N gate before the create-bug write             |

### Seat ↔ BYOK toggle

- **Seat (default):** leave `LLM_MODE` unset (or `seat`). The engine creates a
  Copilot session with just `{ model, tools, streaming }` — no `provider` block.
  Auth comes from your Copilot seat.
- **BYOK fallback:** set `LLM_MODE=byok` plus `LLM_PROVIDER`, `LLM_BASE_URL`, and
  (usually) `LLM_API_KEY`. The engine attaches a `provider` block to the session
  so the model runs against your own endpoint.

### The Azure-vs-OpenAI `provider.type` footgun

Choosing `LLM_PROVIDER` for an Azure-hosted model depends on the **endpoint
shape**, not the vendor:

- **Native Azure OpenAI** — host ends in `*.openai.azure.com` (deployment-based
  URLs, an `api-version` query param). Use **`LLM_PROVIDER=azure`**. The engine
  nests `provider.azure.apiVersion` from `AZURE_API_VERSION`.
- **Azure AI Foundry / OpenAI-compatible** — endpoint serves the OpenAI v1 shape
  under `/openai/v1/`. Use **`LLM_PROVIDER=openai`** even though it is hosted on
  Azure; the `apiVersion` nesting does not apply there.

Picking `azure` for a `/openai/v1/` endpoint (or vice versa) yields confusing
auth/404 errors — match the `type` to the URL shape.

### ADO auth mode + the `az login` (no-PAT) requirement

`ADO_AUTH_MODE=azcli` (default) needs **no PAT**: it uses your `az login`
session and the `azure-devops` CLI extension. Run `az login` first; the startup
doctor verifies it. Set `ADO_AUTH_MODE=pat` (and `ADO_PAT`) only if you must use
a token instead of the CLI.

### Write-confirm gate

`create_bug_from_incident` is the single write tool and is **not**
`skipPermission`. With `CONFIRM_WRITES=true` (default) the SDK routes its
permission request through the CLI, which prompts `… [y/N]`. Answering anything
other than `y`/`yes` rejects the write. On a non-interactive stdin (piped/EOF)
the gate declines automatically rather than hang. Set `CONFIRM_WRITES=false`
to pre-approve writes (not recommended interactively).

### Knowledge crawler

Build a semantic index of internal docs the agent can search.

1. Run a local Ollama with a chat model and an embedding model:
   `ollama pull qwen2.5 && ollama pull nomic-embed-text`
2. Set `CRAWL_SEEDS` (and optionally `CRAWL_ALLOW_DOMAINS`, `CRAWL_TOPIC`) in `.env`.
3. Full ingest: `sre-agent crawl` (or `sre-agent crawl --seed https://wiki/x`).
   Check the index: `sre-agent crawl --status`.
4. In chat the agent uses `search_knowledge` to retrieve, and `index_url` for a
   small on-demand top-up crawl.

The crawler is LLM-guided (a local model decides which pages/links are relevant)
and stores embeddings in a single SQLite + sqlite-vec file (`KNOWLEDGE_DB_PATH`).
It fetches over the existing proxy and assumes network-trusted internal sites (no
credentials). Changing `EMBED_MODEL` after a crawl requires deleting the index
(embedding dim is pinned).

## Manual end-to-end checklist

These steps require a live Copilot seat, live ServiceNow credentials, and an
authenticated `az` session, so they **cannot run in CI** and are **not** covered
by the automated test suite. The automated suite (`npm test`) only exercises the
config → engine wiring (including the BYOK provider seam) with fakes. Run the
checklist manually and record the outcome:

> Status: **unverified in this environment** — no live seat / `az login` /
> ServiceNow instance was available when this milestone was implemented.

1. **Seat chat.** Export the ServiceNow + ADO env (seat mode needs no `LLM_*`
   overrides) and `az login`. Run `npm run dev --workspace @sre/sre-agent`. Ask:
   - `what's at SLA risk for <team>?`
   - `summarize INC0012345`
   Expect a streamed answer with `↳ <tool>…` activity lines.
2. **`az boards` read (no-PAT).** With `ADO_AUTH_MODE=azcli` and `az login` done:
   - `show work item <id>`
   - `list active user stories under <area path>`
   Expect mapped work-item fields with no PAT configured.
3. **The y/N write.** Ask `create a bug for INC0012345`. Expect a `… [y/N]`
   prompt; `n` declines (no bug created), `y` creates and links the ADO bug.
4. **BYOK flip.** Set `LLM_MODE=byok`, `LLM_PROVIDER=azure`,
   `LLM_BASE_URL=https://<name>.openai.azure.com`, `LLM_API_KEY=…`,
   `LLM_MODEL=<deployment>`, `AZURE_API_VERSION=…`. Re-run the same flows and
   confirm answers now stream from your own endpoint. (For a Foundry
   `/openai/v1/` endpoint, use `LLM_PROVIDER=openai` instead — see the footgun
   above.)
