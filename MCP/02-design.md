# SRE Ops MCP Server — Design Document

## 1. Overview

This document provides detailed design specifications for the MCP server components:
- **9 Tools** — Actions for querying and modifying data
- **5 Resources** — Browsable context providers
- **4 Prompts** — Guided workflow templates

---

## 2. Project Structure

```
SREOps/
├── src/                              # Existing (unchanged)
│   ├── integrations/
│   │   ├── servicenow/
│   │   │   ├── IServiceNowClient.ts
│   │   │   ├── ServiceNowClient.ts
│   │   │   └── MockServiceNowClient.ts
│   │   └── ado/
│   │       ├── IAzureDevOpsClient.ts
│   │       ├── AzureDevOpsClient.ts
│   │       └── MockAzureDevOpsClient.ts
│   ├── services/
│   │   ├── slaRiskService.ts
│   │   ├── staleTicketService.ts
│   │   └── changeCorrelationService.ts
│   ├── models/
│   │   └── types.ts
│   └── config/
│       └── configLoader.ts
│
└── mcp/                              # NEW
    ├── src/
    │   ├── index.ts                  # Entry point
    │   ├── server.ts                 # MCP server setup & registration
    │   ├── runtime.ts                # Service wiring (like createRuntime)
    │   ├── tools/
    │   │   ├── index.ts              # Tool registry
    │   │   ├── incidents.ts          # search_incidents, get_incident, summarize_incident
    │   │   ├── changes.ts            # search_changes, get_change, correlate_changes
    │   │   ├── analysis.ts           # find_sla_risks, find_stale_tickets, generate_ops_summary
    │   │   └── ado.ts                # search_work_items, create_bug_from_incident
    │   ├── resources/
    │   │   ├── index.ts              # Resource registry
    │   │   ├── incidents.ts          # incident://{number}, team://{name}/incidents
    │   │   ├── changes.ts            # change://{number}
    │   │   └── dashboards.ts         # sla-dashboard://current, stale-dashboard://current
    │   └── prompts/
    │       ├── index.ts              # Prompt registry
    │       ├── triage.ts             # incident_triage
    │       ├── handover.ts           # shift_handover
    │       ├── changeReview.ts       # change_review
    │       └── postmortem.ts         # incident_postmortem
    ├── package.json
    ├── tsconfig.json
    └── README.md
```

---

## 3. Tool Specifications

### 3.1 Incident Tools (`tools/incidents.ts`)

#### `search_incidents`

Search ServiceNow incidents with flexible filters.

```typescript
{
  name: "search_incidents",
  description: `Search ServiceNow incidents with filters.
Use this to find incidents by state, priority, assignment group, or description.
At least one filter is recommended to avoid large result sets.`,
  inputSchema: {
    type: "object",
    properties: {
      state_not: {
        type: "string",
        description: "Exclude incidents with this state (e.g., 'Closed', 'Resolved')"
      },
      priority: {
        type: "string",
        enum: ["1", "2", "3", "4"],
        description: "Filter by priority: 1=Critical, 2=High, 3=Medium, 4=Low"
      },
      assignment_group: {
        type: "string",
        description: "Filter by assignment group name"
      },
      assigned_to: {
        type: "string",
        description: "Filter by assigned user name"
      },
      short_description_contains: {
        type: "string",
        description: "Search text in short description"
      },
      unassigned_only: {
        type: "boolean",
        description: "Only show incidents with no assignee"
      },
      limit: {
        type: "number",
        description: "Maximum results (default: 50, max: 200)"
      }
    }
  }
}
```

**Returns:**
```typescript
{
  count: number;
  incidents: Array<{
    number: string;
    priority: string;
    state: string;
    shortDescription: string;
    assignedTo: string | null;
    assignmentGroup: string | null;
    openedAt: string;
    updatedAt: string;
  }>;
}
```

---

#### `get_incident`

Get full details of a specific incident.

```typescript
{
  name: "get_incident",
  description: "Get complete details of a specific incident by number (e.g., INC0012345)",
  inputSchema: {
    type: "object",
    properties: {
      number: {
        type: "string",
        description: "Incident number (e.g., INC0012345)"
      }
    },
    required: ["number"]
  }
}
```

**Returns:**
```typescript
{
  number: string;
  priority: string;
  state: string;
  shortDescription: string;
  description: string | null;
  assignedTo: string | null;
  assignmentGroup: string | null;
  businessService: string | null;
  cmdbCi: string | null;
  openedAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  slaDue: string | null;
  workNotes: string[];
  comments: string[];
  impact: string | null;
  urgency: string | null;
}
```

---

#### `summarize_incident`

Get incident with related changes and ADO work items for comprehensive analysis.

```typescript
{
  name: "summarize_incident",
  description: `Get incident details enriched with:
- Related changes (by CI, service, or time window)
- Linked Azure DevOps work items
Use this for incident analysis, triage, or handover.`,
  inputSchema: {
    type: "object",
    properties: {
      number: {
        type: "string",
        description: "Incident number (e.g., INC0012345)"
      }
    },
    required: ["number"]
  }
}
```

**Returns:**
```typescript
{
  incident: Incident;
  relatedChanges: Array<{
    changeNumber: string;
    shortDescription: string;
    state: string;
    risk: string | null;
    correlationReason: string;
    confidenceScore: "High" | "Medium" | "Low";
  }>;
  relatedWorkItems: Array<{
    id: number;
    title: string;
    state: string;
  }>;
}
```

---

### 3.2 Change Tools (`tools/changes.ts`)

#### `search_changes`

```typescript
{
  name: "search_changes",
  description: "Search ServiceNow change records with filters",
  inputSchema: {
    type: "object",
    properties: {
      state_not: {
        type: "string",
        description: "Exclude changes with this state"
      },
      assignment_group: {
        type: "string",
        description: "Filter by assignment group"
      },
      configuration_item: {
        type: "string",
        description: "Filter by configuration item"
      },
      started_after: {
        type: "string",
        description: "Changes started after this date (ISO 8601)"
      },
      started_before: {
        type: "string",
        description: "Changes started before this date (ISO 8601)"
      },
      risk: {
        type: "string",
        enum: ["High", "Medium", "Low"],
        description: "Filter by risk level"
      },
      limit: {
        type: "number",
        description: "Maximum results (default: 50)"
      }
    }
  }
}
```

---

#### `get_change`

```typescript
{
  name: "get_change",
  description: "Get complete details of a specific change record",
  inputSchema: {
    type: "object",
    properties: {
      number: {
        type: "string",
        description: "Change number (e.g., CHG0005432)"
      }
    },
    required: ["number"]
  }
}
```

---

#### `correlate_changes`

```typescript
{
  name: "correlate_changes",
  description: `Find changes that may be related to an incident.
Searches by:
- Same configuration item
- Same business service
- Same assignment group
- Time window around incident creation`,
  inputSchema: {
    type: "object",
    properties: {
      incident_number: {
        type: "string",
        description: "Incident to find related changes for"
      },
      window_hours_before: {
        type: "number",
        description: "Hours before incident to search (default: 24)"
      },
      window_hours_after: {
        type: "number",
        description: "Hours after incident to search (default: 4)"
      }
    },
    required: ["incident_number"]
  }
}
```

---

### 3.3 Analysis Tools (`tools/analysis.ts`)

#### `find_sla_risks`

```typescript
{
  name: "find_sla_risks",
  description: `Find open incidents at risk of SLA breach.
Risk levels:
- Critical: <10% time remaining
- High: <25% time remaining
- Medium: <50% time remaining`,
  inputSchema: {
    type: "object",
    properties: {
      assignment_group: {
        type: "string",
        description: "Filter to specific team"
      },
      priorities: {
        type: "array",
        items: { type: "string" },
        description: "Filter to specific priorities (e.g., ['1', '2'])"
      },
      risk_level: {
        type: "string",
        enum: ["Critical", "High", "Medium"],
        description: "Minimum risk level to include"
      }
    }
  }
}
```

**Returns:**
```typescript
{
  count: number;
  risks: Array<{
    incidentNumber: string;
    priority: string;
    assignmentGroup: string | null;
    slaDue: string | null;
    remainingMinutes: number;
    riskLevel: "Critical" | "High" | "Medium" | "Low";
    suggestedAction: string;
  }>;
}
```

---

#### `find_stale_tickets`

```typescript
{
  name: "find_stale_tickets",
  description: `Find tickets that haven't been updated within expected thresholds.
Default thresholds by priority:
- P1: 30 minutes
- P2: 2 hours
- P3: 24 hours
- P4: 72 hours`,
  inputSchema: {
    type: "object",
    properties: {
      assignment_group: {
        type: "string",
        description: "Filter to specific team"
      },
      priorities: {
        type: "array",
        items: { type: "string" },
        description: "Filter to specific priorities"
      }
    }
  }
}
```

---

#### `generate_ops_summary`

```typescript
{
  name: "generate_ops_summary",
  description: "Generate a daily operations summary with key metrics, risks, and recommended actions",
  inputSchema: {
    type: "object",
    properties: {
      date: {
        type: "string",
        description: "Date for summary (ISO 8601, default: today)"
      },
      assignment_group: {
        type: "string",
        description: "Focus on specific team"
      }
    }
  }
}
```

---

### 3.4 Azure DevOps Tools (`tools/ado.ts`)

#### `search_work_items`

```typescript
{
  name: "search_work_items",
  description: "Search Azure DevOps work items",
  inputSchema: {
    type: "object",
    properties: {
      query_text: {
        type: "string",
        description: "Text to search for (e.g., incident number)"
      },
      work_item_type: {
        type: "string",
        enum: ["Bug", "Task", "User Story", "Issue"],
        description: "Filter by work item type"
      },
      state: {
        type: "string",
        description: "Filter by state (e.g., 'Active', 'Closed')"
      }
    },
    required: ["query_text"]
  }
}
```

---

#### `create_bug_from_incident`

```typescript
{
  name: "create_bug_from_incident",
  description: `Create an Azure DevOps bug linked to a ServiceNow incident.
The bug will include:
- Incident number and description
- Priority mapping
- Standard acceptance criteria
- ServiceNow link`,
  inputSchema: {
    type: "object",
    properties: {
      incident_number: {
        type: "string",
        description: "Incident to create bug from"
      },
      title_override: {
        type: "string",
        description: "Custom title (default: uses incident short description)"
      },
      additional_tags: {
        type: "array",
        items: { type: "string" },
        description: "Extra tags to add"
      },
      area_path: {
        type: "string",
        description: "ADO area path (default: from config)"
      },
      iteration_path: {
        type: "string",
        description: "ADO iteration path (default: from config)"
      }
    },
    required: ["incident_number"]
  }
}
```

---

## 4. Resource Specifications

### 4.1 Incident Resources (`resources/incidents.ts`)

#### `incident://{number}`

```typescript
{
  uri: "incident://INC0012345",
  name: "Incident INC0012345",
  description: "Payment gateway timeout - P1 incident opened 2024-01-15",
  mimeType: "text/markdown"
}
```

**Content Format:**
```markdown
# Incident INC0012345

## Overview
- **Priority:** 1 - Critical
- **State:** In Progress
- **Assigned To:** John Smith
- **Assignment Group:** SRE Team

## Description
Payment gateway experiencing intermittent timeouts affecting 15% of transactions.

## Timeline
- **Opened:** 2024-01-15T10:30:00Z
- **Last Updated:** 2024-01-15T11:45:00Z
- **SLA Due:** 2024-01-15T11:30:00Z ⚠️ BREACHED

## Work Notes
1. [10:35] Initial triage - confirmed timeout pattern in logs
2. [10:50] Identified potential DB connection pool exhaustion
3. [11:15] Scaled connection pool, monitoring

## Comments
- [Customer] We're seeing failed payments on checkout
- [Support] Escalated to SRE team
```

---

#### `team://{name}/incidents`

```typescript
{
  uri: "team://SRE/incidents",
  name: "SRE Team Open Incidents",
  description: "12 open incidents assigned to SRE team",
  mimeType: "text/markdown"
}
```

**Content Format:**
```markdown
# SRE Team - Open Incidents

**Total:** 12 open incidents

## Critical (P1) - 2 incidents
| Number | Description | Assigned | Age |
|--------|-------------|----------|-----|
| INC0012345 | Payment gateway timeout | John Smith | 2h |
| INC0012346 | Auth service degraded | Jane Doe | 45m |

## High (P2) - 4 incidents
| Number | Description | Assigned | Age |
|--------|-------------|----------|-----|
| ... | ... | ... | ... |

## SLA Risks
- INC0012345: 15 minutes remaining ⚠️
- INC0012350: 2 hours remaining

## Stale Tickets
- INC0012340: No update for 3 hours (P2 threshold: 2h)
```

---

### 4.2 Change Resources (`resources/changes.ts`)

#### `change://{number}`

```typescript
{
  uri: "change://CHG0005432",
  name: "Change CHG0005432",
  description: "Database connection pool increase - Implemented",
  mimeType: "text/markdown"
}
```

**Content Format:**
```markdown
# Change CHG0005432

## Overview
- **State:** Implemented
- **Risk:** Medium
- **Type:** Normal

## Description
Increase database connection pool from 100 to 200 connections.

## Schedule
- **Planned Start:** 2024-01-15T09:00:00Z
- **Planned End:** 2024-01-15T10:00:00Z
- **Actual Start:** 2024-01-15T09:15:00Z
- **Actual End:** 2024-01-15T09:45:00Z

## Implementation Plan
1. Update connection pool configuration
2. Rolling restart of application pods
3. Verify connection metrics

## Backout Plan
1. Revert configuration change
2. Rolling restart
3. Verify rollback

## Test Plan
- Monitor connection pool utilization
- Verify no increase in connection errors
```

---

### 4.3 Dashboard Resources (`resources/dashboards.ts`)

#### `sla-dashboard://current`

```typescript
{
  uri: "sla-dashboard://current",
  name: "Current SLA Risk Dashboard",
  description: "5 incidents at risk of SLA breach",
  mimeType: "text/markdown"
}
```

**Content Format:**
```markdown
# SLA Risk Dashboard

**Generated:** 2024-01-15T12:00:00Z

## Summary
- 🔴 Critical Risk: 2 incidents
- 🟠 High Risk: 1 incident
- 🟡 Medium Risk: 2 incidents

## Critical Risk (< 10% time remaining)

| Incident | Priority | Time Remaining | Assigned To | Action |
|----------|----------|----------------|-------------|--------|
| INC0012345 | P1 | 15 min | John Smith | Escalate immediately |
| INC0012346 | P1 | 8 min | Jane Doe | Escalate immediately |

## High Risk (< 25% time remaining)

| Incident | Priority | Time Remaining | Assigned To | Action |
|----------|----------|----------------|-------------|--------|
| INC0012350 | P2 | 30 min | Unassigned | Assign and update |

## Recommended Actions
1. Escalate INC0012346 - only 8 minutes remaining
2. Assign INC0012350 immediately
3. Update INC0012345 with current status
```

---

#### `stale-dashboard://current`

Similar format showing tickets past their update threshold.

---

## 5. Prompt Specifications

### 5.1 `incident_triage` (`prompts/triage.ts`)

```typescript
{
  name: "incident_triage",
  description: "Guide through systematic incident triage process",
  arguments: [
    {
      name: "incident_number",
      description: "Incident to triage",
      required: true
    }
  ]
}
```

**Prompt Template:**
```
You are helping triage ServiceNow incident {incident_number}.

First, use the summarize_incident tool to get full context including related changes.

Then guide the user through:

1. **Impact Assessment**
   - How many users/services are affected?
   - Is there revenue impact?
   - What's the blast radius?

2. **Root Cause Hypothesis**
   - Review related changes - could any have caused this?
   - Check for patterns in recent similar incidents
   - Identify most likely cause

3. **Immediate Actions**
   - What can be done to mitigate right now?
   - Should we roll back any recent changes?
   - Who needs to be notified?

4. **Next Steps**
   - Assign specific action items
   - Set expected update intervals
   - Identify escalation triggers

Be concise and actionable. Focus on what to do now.
```

---

### 5.2 `shift_handover` (`prompts/handover.ts`)

```typescript
{
  name: "shift_handover",
  description: "Generate comprehensive shift handover summary",
  arguments: [
    {
      name: "team_name",
      description: "Team to generate handover for",
      required: true
    },
    {
      name: "hours_back",
      description: "Hours to look back (default: 8)",
      required: false
    }
  ]
}
```

**Prompt Template:**
```
Generate a shift handover summary for the {team_name} team.

Use these tools to gather information:
1. search_incidents - find all open incidents for the team
2. find_sla_risks - identify any SLA risks
3. find_stale_tickets - find tickets needing updates
4. search_changes - find changes in the last {hours_back} hours

Structure the handover as:

## Active Incidents Requiring Attention
- List P1/P2 incidents with current status and next actions

## SLA Risks
- Incidents at risk with time remaining and recommended action

## Tickets Needing Updates
- Stale tickets that need work notes added

## Recent Changes
- Changes deployed in the shift that may be relevant

## Handover Notes
- Key context the next shift needs to know
- Any ongoing investigations
- Scheduled activities coming up

Keep it actionable and prioritized. The incoming shift should know exactly what to focus on first.
```

---

### 5.3 `change_review` (`prompts/changeReview.ts`)

```typescript
{
  name: "change_review",
  description: "Review a change for potential risks and issues",
  arguments: [
    {
      name: "change_number",
      description: "Change to review",
      required: true
    }
  ]
}
```

---

### 5.4 `incident_postmortem` (`prompts/postmortem.ts`)

```typescript
{
  name: "incident_postmortem",
  description: "Structure a post-incident review discussion",
  arguments: [
    {
      name: "incident_number",
      description: "Incident for postmortem",
      required: true
    }
  ]
}
```

---

## 6. Runtime Wiring (`runtime.ts`)

```typescript
import { loadConfig } from "../src/config/configLoader";
import { ServiceNowClient } from "../src/integrations/servicenow/ServiceNowClient";
import { MockServiceNowClient } from "../src/integrations/servicenow/MockServiceNowClient";
import { AzureDevOpsClient } from "../src/integrations/ado/AzureDevOpsClient";
import { MockAzureDevOpsClient } from "../src/integrations/ado/MockAzureDevOpsClient";
import { NoopAzureDevOpsClient } from "../src/integrations/ado/NoopAzureDevOpsClient";
import { SlaRiskService } from "../src/services/slaRiskService";
import { StaleTicketService } from "../src/services/staleTicketService";
import { ChangeCorrelationService } from "../src/services/changeCorrelationService";
import { IncidentService } from "../src/services/incidentService";
import { ReportService } from "../src/services/reportService";

export interface McpRuntime {
  config: AppConfig;
  serviceNowClient: IServiceNowClient;
  azureDevOpsClient: IAzureDevOpsClient;
  incidentService: IncidentService;
  reportService: ReportService;
  slaRiskService: SlaRiskService;
  staleTicketService: StaleTicketService;
  correlationService: ChangeCorrelationService;
}

export const createMcpRuntime = (): McpRuntime => {
  const config = loadConfig();
  
  // Same wiring logic as existing createRuntime()
  const serviceNowClient = config.serviceNow.enabled 
    ? new ServiceNowClient(config.serviceNow) 
    : new MockServiceNowClient();
    
  const azureDevOpsClient = config.azureDevOps.enabled
    ? new AzureDevOpsClient(config.azureDevOps)
    : config.azureDevOps.disabledMode === "mock"
      ? new MockAzureDevOpsClient()
      : new NoopAzureDevOpsClient();

  // ... rest of service wiring
  
  return {
    config,
    serviceNowClient,
    azureDevOpsClient,
    incidentService,
    reportService,
    slaRiskService,
    staleTicketService,
    correlationService
  };
};
```

---

## 7. Error Handling

### 7.1 Error Response Format

All tool errors return structured responses:

```typescript
{
  isError: true,
  content: [
    {
      type: "text",
      text: "Failed to fetch incident: INC0012345 not found"
    }
  ]
}
```

### 7.2 Error Categories

| Error Type | Handling | User Message |
|------------|----------|--------------|
| Not Found | Return empty/null gracefully | "Incident INC0012345 not found" |
| Auth Failure | Clear message about which system | "ServiceNow authentication failed. Check credentials." |
| Timeout | Suggest retry | "ServiceNow request timed out. Please try again." |
| Validation | Explain what's wrong | "Invalid incident number format. Expected: INCxxxxxxx" |
| Rate Limit | Suggest wait | "ServiceNow rate limit reached. Wait 60 seconds." |

---

## 8. Configuration

### 8.1 Environment Variables

Reuses existing `.env` with MCP-specific additions:

```bash
# Existing (reused)
ENABLE_SERVICENOW_INTEGRATION=true
SERVICENOW_BASE_URL=https://company.service-now.com
SERVICENOW_BASIC_AUTH_HEADER=Basic ...

ENABLE_ADO_INTEGRATION=true
ADO_ORG_URL=https://dev.azure.com/company
ADO_PROJECT=SRE
ADO_PAT=...

# MCP-specific (new)
MCP_LOG_LEVEL=info              # debug | info | warn | error
MCP_LOG_FILE=/var/log/mcp.log   # optional file logging
```

---

## 9. Testing Strategy

### 9.1 Unit Tests

```
mcp/tests/
├── tools/
│   ├── incidents.test.ts    # Mock ServiceNowClient
│   ├── changes.test.ts
│   ├── analysis.test.ts
│   └── ado.test.ts
├── resources/
│   ├── incidents.test.ts
│   └── dashboards.test.ts
└── prompts/
    └── templates.test.ts
```

### 9.2 Integration Tests

```typescript
// Test with MockServiceNowClient
describe("search_incidents tool", () => {
  it("returns filtered incidents", async () => {
    const runtime = createMcpRuntime(); // uses mocks
    const result = await searchIncidentsTool.handler({ priority: "1" });
    expect(result.incidents).toHaveLength(2);
  });
});
```

---

## 10. Deployment

### 10.1 Copilot CLI Configuration

`~/.config/github-copilot/mcp.json`:

```json
{
  "mcpServers": {
    "sre-ops": {
      "command": "node",
      "args": ["/path/to/SREOps/mcp/dist/index.js"],
      "env": {
        "SERVICENOW_BASE_URL": "https://...",
        "SERVICENOW_BASIC_AUTH_HEADER": "Basic ...",
        "ADO_ORG_URL": "https://...",
        "ADO_PAT": "..."
      }
    }
  }
}
```

### 10.2 VS Code Configuration

`.vscode/mcp.json` or workspace settings:

```json
{
  "mcp.servers": {
    "sre-ops": {
      "command": "node",
      "args": ["${workspaceFolder}/mcp/dist/index.js"]
    }
  }
}
```

---

## Next Steps

1. ✅ Architecture document
2. ✅ Design document (this file)
3. ⏳ Implementation plan (`03-implementation-plan.md`)
4. ⏳ Implementation
