# SRE Ops MCP Server

MCP (Model Context Protocol) server that exposes SRE operations tools for use with GitHub Copilot CLI and Copilot in IDEs.

## Features

### Tools (11)
| Tool | Description |
|------|-------------|
| `search_incidents` | Search ServiceNow incidents with filters |
| `get_incident` | Get full incident details |
| `summarize_incident` | Get incident with related changes and ADO items |
| `search_changes` | Search ServiceNow changes |
| `get_change` | Get full change details |
| `correlate_changes` | Find changes related to an incident |
| `find_sla_risks` | Find incidents at risk of SLA breach |
| `find_stale_tickets` | Find tickets not updated within thresholds |
| `generate_ops_summary` | Generate daily operations summary |
| `search_work_items` | Search Azure DevOps work items |
| `create_bug_from_incident` | Create ADO bug from incident |

### Resources (5)
| Resource | Description |
|----------|-------------|
| `incident://{number}` | Full incident as markdown |
| `change://{number}` | Full change as markdown |
| `team://{name}/incidents` | Team's open incidents dashboard |
| `sla-dashboard://current` | Live SLA risk view |
| `stale-dashboard://current` | Stale tickets view |

### Prompts (4)
| Prompt | Description |
|--------|-------------|
| `incident_triage` | Guided incident triage workflow |
| `shift_handover` | Generate shift handover summary |
| `change_review` | Review change for risks |
| `incident_postmortem` | Structure postmortem discussion |

## Setup

### 1. Install Dependencies

```bash
cd MCP
npm install
```

### 2. Build

```bash
npm run build
```

### 3. Configure MCP Client

See the [Configuration](#configuration) section for required environment variables, then wire them into your MCP client config (examples below).

### 4. Configure Copilot CLI

Add to `~/.config/github-copilot/mcp.json`:

```json
{
  "mcpServers": {
    "sre-ops": {
      "command": "node",
      "args": ["/absolute/path/to/MCP/dist/index.js"],
      "env": {
        "SERVICENOW_BASE_URL": "https://yourcompany.service-now.com",
        "SERVICENOW_USERNAME": "your-username",
        "SERVICENOW_PASSWORD": "your-password"
      }
    }
  }
}
```

### 5. Configure VS Code (Optional)

Add to `.vscode/settings.json` or workspace settings:

```json
{
  "github.copilot.chat.mcp.servers": {
    "sre-ops": {
      "command": "node",
      "args": ["/absolute/path/to/MCP/dist/index.js"],
      "env": {
        "SERVICENOW_BASE_URL": "https://yourcompany.service-now.com",
        "SERVICENOW_USERNAME": "your-username",
        "SERVICENOW_PASSWORD": "your-password"
      }
    }
  }
}
```

## Configuration

All configuration is via environment variables (set them in the `env` block of your MCP client config).

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SERVICENOW_BASE_URL` | yes | — | e.g. `https://yourcompany.service-now.com` |
| `SERVICENOW_USERNAME` | yes | — | Basic auth user |
| `SERVICENOW_PASSWORD` | yes | — | Basic auth password |
| `SERVICENOW_PROXY` | no | — | HTTP proxy for ServiceNow calls, e.g. `http://proxy.corp.net:8080` |
| `ADO_ENABLED` | no | `false` | Enable Azure DevOps integration |
| `ADO_ORG_URL` | if ADO enabled | — | e.g. `https://dev.azure.com/yourorg` |
| `ADO_PROJECT` | if ADO enabled | — | ADO project name |
| `ADO_PAT` | if ADO enabled | — | Personal Access Token (Work Items read/write) |
| `ADO_PROXY` | no | — | HTTP proxy for Azure DevOps calls |
| `ADO_AREA_PATH` | no | project name | Default area path for created bugs |
| `ADO_ITERATION_PATH` | no | project name | Default iteration path for created bugs |
| `ADO_ASSIGNED_TEAM` | no | — | Default team for created bugs |
| `ADO_CREATE_BUG_ENABLED` | no | `true` | Feature flag for `create_bug_from_incident` |
| `STALE_P1_MIN` / `STALE_P2_MIN` / `STALE_P3_MIN` / `STALE_P4_MIN` | no | 30 / 120 / 1440 / 4320 | Stale thresholds (minutes) |
| `CORRELATION_HOURS_BEFORE` / `CORRELATION_HOURS_AFTER` | no | 24 / 4 | Change correlation window around incident open time |

## Usage Examples

### Copilot CLI

```bash
# Search for P1 incidents
copilot "Show me all P1 incidents"

# Analyze an incident
copilot "Summarize incident INC0012345 and check for related changes"

# Check SLA risks
copilot "What incidents are at risk of SLA breach?"

# Shift handover
copilot "Generate a shift handover for the SRE team"

# Create a bug
copilot "Create an ADO bug for INC0012345"
```

### Using Prompts

```bash
# Use the triage prompt
copilot --prompt incident_triage --incident_number INC0012345

# Use the handover prompt
copilot --prompt shift_handover --team_name SRE
```

### Using Resources

Resources can be attached to conversations for context:

```bash
# Attach incident details
copilot "Analyze this incident" --resource incident://INC0012345

# Attach SLA dashboard
copilot "What should I focus on?" --resource sla-dashboard://current
```

## Development

### Run in Development Mode

```bash
npm run dev
```

### Run Tests

```bash
npm test
```

### Project Structure

```
MCP/
├── src/
│   ├── index.ts          # Entry point
│   ├── server.ts         # MCP server setup
│   ├── runtime.ts        # Service wiring
│   ├── tools/            # Tool implementations
│   ├── resources/        # Resource providers
│   └── prompts/          # Prompt templates
├── package.json
└── tsconfig.json
```

## Architecture

```
MCP Server
    │
    ▼
┌─────────────────────────────┐
│        MCP Protocol         │
│   (Tools, Resources, Prompts)│
└─────────────┬───────────────┘
              │
┌─────────────▼───────────────┐
│       Built-in Services      │
│  IncidentService, SlaRisk,   │
│  StaleTicket, Correlation    │
└─────────────┬───────────────┘
              │
┌─────────────▼───────────────┐
│     Integration Clients      │
│  ServiceNowClient, ADOClient │
└─────────────────────────────┘
```

## Troubleshooting

### Server won't start

1. Check that dependencies are installed: `npm install`
2. Verify build succeeded: `npm run build`
3. Check that all required environment variables are set (`SERVICENOW_BASE_URL`, `SERVICENOW_USERNAME`, `SERVICENOW_PASSWORD`)

### ServiceNow connection fails

1. Verify `SERVICENOW_BASE_URL` is correct (no trailing slash)
2. Check credentials — test them directly:
   ```bash
   curl -u "$SERVICENOW_USERNAME:$SERVICENOW_PASSWORD" \
     "$SERVICENOW_BASE_URL/api/now/table/incident?sysparm_limit=1"
   ```
3. Confirm the account has the `itil` or `sn_incident_read` role in ServiceNow

### ADO tools not working

1. Ensure `ADO_ENABLED=true` is set
2. Verify `ADO_ORG_URL`, `ADO_PROJECT`, and `ADO_PAT` are all set
3. Confirm the PAT has **Work Items (Read & Write)** scope

### Tools not appearing in Copilot

1. Verify MCP config file location is correct
2. Check that the path to `dist/index.js` is absolute
3. Restart Copilot CLI after config changes
