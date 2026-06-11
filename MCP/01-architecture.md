# SRE Ops MCP Server — Architecture Document

## 1. Executive Summary

This document describes the architecture for an **MCP (Model Context Protocol) Server** that exposes SRE operational capabilities to AI assistants like GitHub Copilot CLI and Copilot in IDEs.

### Goals
- Provide natural language access to ServiceNow incidents and changes
- Enable SLA risk analysis and stale ticket detection
- Support change correlation for incident investigation
- Allow Azure DevOps bug creation from incidents
- Minimize code by leveraging existing service layer from `SREOps`

### Non-Goals (Out of Scope)
- Teams bot integration (remains separate if needed)
- Custom web UI (Copilot CLI/IDE is the interface)
- Custom authentication UI (uses `copilot login`)

---

## 2. System Context

```
┌─────────────────────────────────────────────────────────────────────┐
│                         User Interfaces                              │
├─────────────────┬─────────────────┬─────────────────────────────────┤
│  Copilot CLI    │  VS Code        │  JetBrains IDEs                 │
│  (Terminal)     │  Copilot Chat   │  Copilot Chat                   │
└────────┬────────┴────────┬────────┴────────┬────────────────────────┘
         │                 │                 │
         └─────────────────┼─────────────────┘
                           │ MCP Protocol (stdio/HTTP)
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      SRE Ops MCP Server                              │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                    Tool Definitions                          │    │
│  │  • search_incidents    • get_incident    • find_sla_risks   │    │
│  │  • find_stale_tickets  • correlate_changes                  │    │
│  │  • search_changes      • get_change      • create_ado_bug   │    │
│  └─────────────────────────────────────────────────────────────┘    │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                    Resource Providers                        │    │
│  │  • Incident summaries   • SLA dashboards   • Runbooks       │    │
│  └─────────────────────────────────────────────────────────────┘    │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │                    Prompt Templates                          │    │
│  │  • incident_triage   • shift_handover   • change_review     │    │
│  └─────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
                           │
         ┌─────────────────┼─────────────────┐
         │                 │                 │
         ▼                 ▼                 ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│   ServiceNow    │ │  Azure DevOps   │ │   (Future)      │
│   ITSM API      │ │   REST API      │ │   PagerDuty,    │
│                 │ │                 │ │   Datadog, etc. │
└─────────────────┘ └─────────────────┘ └─────────────────┘
```

---

## 3. MCP Concepts Mapping

| MCP Concept | SRE Ops Implementation |
|-------------|------------------------|
| **Tools** | Actions that query/modify external systems (ServiceNow, ADO) |
| **Resources** | Read-only data views (incident details, SLA status, runbooks) |
| **Prompts** | Pre-built prompt templates for common workflows |
| **Sampling** | Not used (we don't need server-side LLM calls) |

---

## 4. Component Architecture

### 4.1 Layer Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        MCP Protocol Layer                        │
│  • JSON-RPC over stdio (primary)                                │
│  • HTTP+SSE transport (optional, for remote deployment)         │
└───────────────────────────────┬─────────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────┐
│                        MCP Server Core                           │
│  • Tool registration & dispatch                                 │
│  • Resource provider registry                                   │
│  • Prompt template registry                                     │
│  • Request validation                                           │
│  • Error handling & logging                                     │
└───────────────────────────────┬─────────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────┐
│                      Domain Services Layer                       │
│  (Reused from existing SREOps codebase)                         │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐               │
│  │ SlaRisk     │ │ StaleTicket │ │ Change      │               │
│  │ Service     │ │ Service     │ │ Correlation │               │
│  └─────────────┘ └─────────────┘ └─────────────┘               │
└───────────────────────────────┬─────────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────┐
│                      Integration Layer                           │
│  (Reused from existing SREOps codebase)                         │
│  ┌─────────────────────┐    ┌─────────────────────┐            │
│  │  ServiceNowClient   │    │  AzureDevOpsClient  │            │
│  │  IServiceNowClient  │    │  IAzureDevOpsClient │            │
│  └─────────────────────┘    └─────────────────────┘            │
└───────────────────────────────┬─────────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────┐
│                      Configuration Layer                         │
│  • Environment variables (.env)                                 │
│  • ConfigLoader (reused)                                        │
└─────────────────────────────────────────────────────────────────┘
```

### 4.2 Directory Structure

```
SREOps/
├── src/                          # Existing source (reused)
│   ├── integrations/
│   │   ├── servicenow/           # ← Reuse ServiceNowClient
│   │   └── ado/                  # ← Reuse AzureDevOpsClient
│   ├── services/                 # ← Reuse domain services
│   ├── models/                   # ← Reuse type definitions
│   └── config/                   # ← Reuse configLoader
│
├── mcp/                          # NEW: MCP Server
│   ├── src/
│   │   ├── index.ts              # Entry point, server bootstrap
│   │   ├── server.ts             # MCP server setup
│   │   ├── tools/                # Tool definitions
│   │   │   ├── incidents.ts      # Incident-related tools
│   │   │   ├── changes.ts        # Change-related tools
│   │   │   ├── analysis.ts       # SLA risk, stale tickets
│   │   │   └── ado.ts            # Azure DevOps tools
│   │   ├── resources/            # Resource providers
│   │   │   ├── incidents.ts      # Incident detail resources
│   │   │   └── dashboards.ts     # SLA/stale dashboards
│   │   └── prompts/              # Prompt templates
│   │       ├── triage.ts         # Incident triage workflow
│   │       └── handover.ts       # Shift handover workflow
│   ├── package.json              # MCP server dependencies
│   └── tsconfig.json             # TypeScript config
│
└── MCP/                          # Documentation (this folder)
    ├── 01-architecture.md
    ├── 02-design.md
    └── 03-implementation-plan.md
```

---

## 5. Tool Definitions

### 5.1 Incident Tools

| Tool Name | Description | Parameters |
|-----------|-------------|------------|
| `search_incidents` | Search incidents with filters | `state_not`, `priority`, `assignment_group`, `assigned_to`, `description_contains`, `limit` |
| `get_incident` | Get full details of one incident | `number` (required) |
| `summarize_incident` | Get incident with related changes and ADO items | `number` (required) |

### 5.2 Change Tools

| Tool Name | Description | Parameters |
|-----------|-------------|------------|
| `search_changes` | Search change records with filters | `state_not`, `assignment_group`, `configuration_item`, `started_after`, `limit` |
| `get_change` | Get full details of one change | `number` (required) |
| `correlate_changes` | Find changes related to an incident | `incident_number` (required), `window_hours_before`, `window_hours_after` |

### 5.3 Analysis Tools

| Tool Name | Description | Parameters |
|-----------|-------------|------------|
| `find_sla_risks` | Find incidents at risk of SLA breach | `assignment_group`, `priorities` |
| `find_stale_tickets` | Find tickets not updated within thresholds | `assignment_group`, `priorities` |
| `generate_ops_summary` | Generate daily operations summary | `date` (optional, defaults to today) |

### 5.4 Azure DevOps Tools

| Tool Name | Description | Parameters |
|-----------|-------------|------------|
| `search_work_items` | Search ADO work items | `query_text`, `work_item_type`, `state` |
| `create_bug_from_incident` | Create ADO bug linked to incident | `incident_number` (required), `title_override`, `additional_tags` |

---

## 6. Resource Definitions

Resources provide read-only access to data that can be attached to conversations.

| Resource URI Pattern | Description |
|---------------------|-------------|
| `incident://{number}` | Full incident details as structured text |
| `change://{number}` | Full change record details |
| `sla-dashboard://current` | Current SLA risk dashboard |
| `stale-dashboard://current` | Current stale tickets dashboard |
| `runbook://{service}/{topic}` | Operational runbooks (future) |

---

## 7. Prompt Templates

Pre-built prompts for common SRE workflows:

| Prompt Name | Description | Arguments |
|-------------|-------------|-----------|
| `incident_triage` | Guide through incident triage | `incident_number` |
| `shift_handover` | Generate shift handover summary | `team_name`, `hours_back` |
| `change_review` | Review change for risks | `change_number` |
| `incident_postmortem` | Structure postmortem discussion | `incident_number` |

---

## 8. Data Flow Examples

### 8.1 User Asks: "Show me P1 incidents not assigned"

```
User ──► Copilot CLI ──► MCP Server
                              │
                              ▼
                    ┌─────────────────┐
                    │ search_incidents│
                    │ tool invoked    │
                    │ priority=1      │
                    │ assigned_to=""  │
                    └────────┬────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │ ServiceNowClient│
                    │ listIncidents   │
                    └────────┬────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │ JSON Response   │
                    │ [{INC001...}]   │
                    └────────┬────────┘
                             │
Copilot CLI ◄── formats ◄───┘
   │
User sees formatted incident list
```

### 8.2 User Asks: "Create a bug for INC0012345"

```
User ──► Copilot CLI ──► MCP Server
                              │
                              ▼
                    ┌─────────────────────┐
                    │ create_bug_from_    │
                    │ incident tool       │
                    │ incident=INC0012345 │
                    └────────┬────────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
     ┌────────────┐  ┌────────────┐  ┌────────────┐
     │ Get        │  │ Get        │  │ Get ADO    │
     │ Incident   │  │ Related    │  │ Template   │
     │ Details    │  │ Changes    │  │ Config     │
     └─────┬──────┘  └─────┬──────┘  └─────┬──────┘
           │               │               │
           └───────────────┼───────────────┘
                           ▼
                    ┌─────────────────┐
                    │ AzureDevOps     │
                    │ createBug()     │
                    └────────┬────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │ Bug ID + URL    │
                    └────────┬────────┘
                             │
Copilot CLI ◄── confirms ◄───┘
```

---

## 9. Security Considerations

### 9.1 Authentication

| System | Auth Method |
|--------|-------------|
| MCP Client → Server | Implicit (stdio is local process) or API key for HTTP |
| Server → ServiceNow | Basic Auth header or username/password (from env) |
| Server → Azure DevOps | PAT token or Azure CLI (`az login`) |

### 9.2 Authorization

- MCP server runs with the permissions of the user who started it
- ServiceNow/ADO access is controlled by the credentials configured
- No additional RBAC layer (inherits from backend systems)

### 9.3 Data Handling

- No data persisted locally (stateless server)
- Sensitive fields (credentials) loaded from environment only
- Logs should not include PII or credentials

---

## 10. Error Handling Strategy

| Error Type | Handling |
|------------|----------|
| ServiceNow API error | Return structured error with status code and message |
| ADO API error | Return structured error with request ID for debugging |
| Invalid parameters | Return validation error before calling backend |
| Timeout | Return timeout error with suggestion to retry |
| Auth failure | Return clear message about which system failed auth |

---

## 11. Deployment Options

### 11.1 Local (stdio) — Primary

```bash
# In Copilot CLI config (~/.config/github-copilot/mcp.json)
{
  "mcpServers": {
    "sre-ops": {
      "command": "node",
      "args": ["C:/work/git/SREOps/mcp/dist/index.js"],
      "env": {
        "SERVICENOW_BASE_URL": "https://...",
        "SERVICENOW_BASIC_AUTH_HEADER": "Basic ..."
      }
    }
  }
}
```

### 11.2 Remote (HTTP+SSE) — Future

For shared team deployment, the MCP server can run as an HTTP service:

```
┌─────────────┐     HTTPS      ┌─────────────────┐
│ Copilot CLI │ ◄────────────► │ MCP Server      │
│ (any user)  │                │ (shared infra)  │
└─────────────┘                └─────────────────┘
```

---

## 12. Dependencies

### New Dependencies (mcp/package.json)

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.x",
    "zod": "^3.x"           // Schema validation (optional, SDK may include)
  }
}
```

### Reused from Main Project

- `axios` (ServiceNow/ADO HTTP calls)
- `dotenv` (configuration)
- Type definitions from `src/models/types.ts`
- All service classes from `src/services/`
- All integration clients from `src/integrations/`

---

## 13. Success Metrics

| Metric | Target |
|--------|--------|
| Tool response time (P95) | < 2 seconds |
| Error rate | < 1% |
| Lines of code (MCP layer) | < 500 |
| Reuse of existing code | > 80% of integration logic |

---

## 14. Open Questions

1. **Should we support HTTP transport from day one?** Or start with stdio only?
2. **Do we need resource providers?** Or are tools sufficient for MVP?
3. **Should prompt templates be included in MVP?** Or phase 2?
4. **Audit logging**: Should MCP server log tool invocations separately?

---

## Next Steps

1. Review and approve architecture
2. Create detailed design document (`02-design.md`)
3. Create implementation plan (`03-implementation-plan.md`)
4. Begin implementation
