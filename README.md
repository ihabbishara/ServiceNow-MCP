# SRE Agent — ServiceNow / Azure DevOps chatbot

A command-line chatbot for SRE work: triage ServiceNow incidents, review changes,
spot SLA risk, and create/inspect Azure DevOps work items. It runs on the official
**GitHub Copilot SDK** (your Copilot seat — no MCP server) and reaches Azure DevOps
through the **Azure CLI** under `az login` (no PAT).

This is an npm-workspaces monorepo; the chatbot is `packages/sre-agent`.

## Prerequisites (Mac and Windows)

- **Node.js 20.19+ or 22.12+** — `node -v`
- **Git**
- **A GitHub Copilot seat** (the agent logs you in on first run)
- **Azure CLI** with the Azure DevOps extension — only if `ADO_AUTH_MODE=azcli` (the default):
  - `az login`
  - `az extension add --name azure-devops`

## Quick start

```bash
git clone git@github.com:ihabbishara/ServiceNow-MCP.git
cd ServiceNow-MCP
npm run setup     # installs dependencies and builds all packages
npm start         # first run scaffolds your config, logs you in, then chats
```

`npm start` on a fresh clone will:
1. prompt for your ServiceNow URL/username/password and Azure DevOps org/project
   (writing `packages/sre-agent/.env`, chmod 600),
2. check `az login`,
3. run the Copilot device-flow login if you're not already authenticated
   (prints a `github.com/login/device` code), then
4. drop you into the chat prompt.

You never pass `--env-file` and never run `node …/dist/…` by hand.

### Useful commands

| Command | What it does |
|---|---|
| `npm start` | Start the chat REPL |
| `npm start -- doctor` | Check every prerequisite (Node, Azure CLI + login + extension, Copilot auth, config) and print a fix for each failure |
| `npm start -- init` | Re-run the interactive config scaffolder |
| `npm test` | Run the test suite |

Inside the chat, type `/help` for workflow commands (`/triage`, `/review`,
`/postmortem`, `/handover`) and `/login` to re-authenticate to Copilot. The model
has 14 tools (ServiceNow, Azure DevOps, knowledge) — full roster in
[`packages/sre-agent/README.md`](packages/sre-agent/README.md#tools).

### Windows (PowerShell) notes

The commands above are identical in PowerShell:

```powershell
git clone git@github.com:ihabbishara/ServiceNow-MCP.git
cd ServiceNow-MCP
npm run setup
npm start
```

## Configuration

`sre-agent init` writes `packages/sre-agent/.env`. To edit by hand, copy
[`packages/sre-agent/.env.example`](packages/sre-agent/.env.example) — every
variable is documented there. The agent loads the first `.env` it finds, in order:
`$SRE_AGENT_ENV` → `./.env` → `packages/sre-agent/.env` → `~/.sre-agent/.env`.

**Auth modes:**
- **seat** (default) — uses your GitHub Copilot seat. By default the agent strips
  ambient `GH_TOKEN`/`GITHUB_TOKEN` from the runtime so it uses your `copilot login`
  identity (those env tokens are the usual cause of `Authorization error … /login`).
- **byok** — bring your own key (Azure OpenAI / Anthropic / OpenAI); set
  `LLM_MODE=byok` plus `LLM_PROVIDER` and `LLM_BASE_URL`.

## Knowledge crawler (RAG over internal docs)

The agent can crawl your internal documentation (runbooks, wikis, KB) into a local
semantic index and use it to answer questions. It works in **both** LLM modes and
needs **no Ollama** — embeddings run locally in-process (transformers.js/ONNX).

```bash
# 1. point it at seed URLs (in .env)
CRAWL_SEEDS=https://wiki.acme.io/sre, https://kb.acme.io/runbooks

# 2. build / refresh the index (runs outside any Copilot session)
npm start -- crawl                 # full ingest from CRAWL_SEEDS
npm start -- crawl --status        # show index stats (pages, chunks, model, dim)
```

Once `CRAWL_SEEDS` is set, the chat is **automatically steered** to consult the
index: free-form how-to/runbook questions and the `/triage`, `/review`,
`/postmortem`, `/handover` workflows call the `search_knowledge` tool and cite
source URLs. `index_url <url>` does a small on-demand top-up mid-chat.

- **Offline / locked-down networks:** set `EMBED_MODEL_PATH` to a vendored model
  directory so the embed model never downloads from Hugging Face.
- **Crawl scope** is bounded to `CRAWL_ALLOW_DOMAINS` (defaults to the seed hosts).
- Changing `EMBED_MODEL` after a crawl requires deleting the index and re-crawling.

Full reference: [`packages/sre-agent/README.md`](packages/sre-agent/README.md#knowledge-crawler)
and every variable in [`.env.example`](packages/sre-agent/.env.example).

## Troubleshooting

Run `npm start -- doctor` first — it pinpoints most issues. Common ones:

| Symptom | Fix |
|---|---|
| `Authorization error, you may need to run /login` | Type `/login`, or unset `GH_TOKEN`/`GITHUB_TOKEN`, or set `COPILOT_GITHUB_TOKEN`. The agent strips ambient tokens by default — make sure you rebuilt (`npm run build`). |
| `Azure CLI is not logged in` | `az login` (and `az extension add --name azure-devops`). |
| `Invalid configuration: …` | `npm start -- init`, or fix the named variable in `.env`. |
| Changes don't take effect | `git pull && npm run build` (the CLI runs the compiled `dist/`, not the source). |
