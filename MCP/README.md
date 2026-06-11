# SRE Ops MCP Server

MCP (Model Context Protocol) server that exposes SRE operations tools for use with GitHub Copilot CLI and Copilot in IDEs.

## Features

### Tools (9)
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
cd mcp
npm install
```

### 2. Build

```bash
npm run build
```

### 3. Configure Environment

The MCP server uses the same `.env` file as the main SREOps project. Ensure these are set:

```bash
# ServiceNow
ENABLE_SERVICENOW_INTEGRATION=true
SERVICENOW_BASE_URL=https://your-instance.service-now.com
SERVICENOW_BASIC_AUTH_HEADER=Basic ...

# Azure DevOps (optional)
ENABLE_ADO_INTEGRATION=true
ADO_ORG_URL=https://dev.azure.com/your-org
ADO_PROJECT=YourProject
ADO_PAT=your-pat-token
```

### 4. Configure Copilot CLI

Add to `~/.config/github-copilot/mcp.json`:

```json
{
  "mcpServers": {
    "sre-ops": {
      "command": "node",
      "args": ["C:/path/to/SREOps/mcp/dist/index.js"],
      "env": {
        "SERVICENOW_BASE_URL": "https://your-instance.service-now.com",
        "SERVICENOW_BASIC_AUTH_HEADER": "Basic ..."
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
      "args": ["${workspaceFolder}/mcp/dist/index.js"]
    }
  }
}
```

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
mcp/
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

The MCP server reuses the existing SREOps service layer:

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
│     Existing Services        │
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
3. Check environment variables are set

### ServiceNow connection fails

1. Verify `SERVICENOW_BASE_URL` is correct
2. Check authentication credentials
3. Test with `ENABLE_SERVICENOW_INTEGRATION=false` to use mock data

### Tools not appearing in Copilot

1. Verify MCP config file location is correct
2. Check that the path to `dist/index.js` is absolute
3. Restart Copilot CLI after config changes
