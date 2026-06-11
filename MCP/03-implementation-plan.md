# SRE Ops MCP Server — Implementation Plan

## Overview

| Metric | Value |
|--------|-------|
| **Total Phases** | 5 |
| **Estimated Effort** | 4-6 hours |
| **New Lines of Code** | ~600-800 |
| **Reused Code** | ~2000+ (existing services) |

---

## Phase 1: Project Setup

**Goal:** Establish MCP project structure with working build and dependencies.

### Tasks

| ID | Task | Description | Est. |
|----|------|-------------|------|
| 1.1 | Create `mcp/` directory structure | `src/`, `tools/`, `resources/`, `prompts/` folders | 5m |
| 1.2 | Create `package.json` | Dependencies: `@modelcontextprotocol/sdk`, TypeScript | 5m |
| 1.3 | Create `tsconfig.json` | Extend root config, reference `../src` for imports | 5m |
| 1.4 | Create `runtime.ts` | Adapt `createRuntime()` for MCP use | 15m |
| 1.5 | Create `index.ts` entry point | Bootstrap MCP server with stdio transport | 10m |
| 1.6 | Create `server.ts` | MCP server setup, register tools/resources/prompts | 15m |
| 1.7 | Verify build | `npm run build` succeeds, server starts | 5m |

**Deliverable:** `npm run build` works, server starts and responds to MCP protocol.

**Dependencies:** None

---

## Phase 2: Core Tools

**Goal:** Implement the 9 tools that provide core functionality.

### Tasks

| ID | Task | Description | Est. |
|----|------|-------------|------|
| 2.1 | Create `tools/index.ts` | Tool registry, exports all tools | 5m |
| 2.2 | Implement `search_incidents` | Filter incidents by state, priority, group, text | 20m |
| 2.3 | Implement `get_incident` | Fetch single incident by number | 10m |
| 2.4 | Implement `summarize_incident` | Get incident + related changes + ADO items | 15m |
| 2.5 | Implement `search_changes` | Filter changes by state, group, CI, date | 15m |
| 2.6 | Implement `get_change` | Fetch single change by number | 10m |
| 2.7 | Implement `correlate_changes` | Find changes related to incident | 15m |
| 2.8 | Implement `find_sla_risks` | Use SlaRiskService | 15m |
| 2.9 | Implement `find_stale_tickets` | Use StaleTicketService | 15m |
| 2.10 | Implement `generate_ops_summary` | Use ReportService | 15m |
| 2.11 | Implement `search_work_items` | Search ADO work items | 10m |
| 2.12 | Implement `create_bug_from_incident` | Create ADO bug from incident | 20m |

**Deliverable:** All 9 tools callable via MCP protocol.

**Dependencies:** Phase 1

---

## Phase 3: Resources

**Goal:** Implement 5 resource providers for browsable context.

### Tasks

| ID | Task | Description | Est. |
|----|------|-------------|------|
| 3.1 | Create `resources/index.ts` | Resource registry | 5m |
| 3.2 | Implement `incident://{number}` | Render incident as markdown | 20m |
| 3.3 | Implement `change://{number}` | Render change as markdown | 15m |
| 3.4 | Implement `team://{name}/incidents` | Team incidents dashboard | 20m |
| 3.5 | Implement `sla-dashboard://current` | SLA risk dashboard | 15m |
| 3.6 | Implement `stale-dashboard://current` | Stale tickets dashboard | 15m |

**Deliverable:** Resources browsable and attachable in Copilot.

**Dependencies:** Phase 2 (uses same data fetching)

---

## Phase 4: Prompts

**Goal:** Implement 4 prompt templates for guided workflows.

### Tasks

| ID | Task | Description | Est. |
|----|------|-------------|------|
| 4.1 | Create `prompts/index.ts` | Prompt registry | 5m |
| 4.2 | Implement `incident_triage` | Triage workflow prompt | 10m |
| 4.3 | Implement `shift_handover` | Handover summary prompt | 10m |
| 4.4 | Implement `change_review` | Change review prompt | 10m |
| 4.5 | Implement `incident_postmortem` | Postmortem prompt | 10m |

**Deliverable:** Prompts available in Copilot prompt picker.

**Dependencies:** Phase 2 (prompts reference tools)

---

## Phase 5: Testing & Documentation

**Goal:** Verify functionality and document usage.

### Tasks

| ID | Task | Description | Est. |
|----|------|-------------|------|
| 5.1 | Create `mcp/README.md` | Setup instructions, usage examples | 15m |
| 5.2 | Add unit tests for tools | Test with MockServiceNowClient | 30m |
| 5.3 | Manual testing with Copilot CLI | Verify all tools/resources/prompts work | 20m |
| 5.4 | Create sample MCP config | Example `mcp.json` for Copilot CLI | 5m |
| 5.5 | Update root README | Link to MCP documentation | 5m |

**Deliverable:** Working, tested, documented MCP server.

**Dependencies:** Phases 2, 3, 4

---

## Implementation Order

```
Phase 1: Setup (1 hour)
    │
    ▼
Phase 2: Tools (2.5 hours)
    │
    ├──────────────┐
    ▼              ▼
Phase 3:       Phase 4:
Resources      Prompts
(1.5 hours)    (45 min)
    │              │
    └──────┬───────┘
           ▼
    Phase 5: Testing
    (1.25 hours)
```

---

## File Creation Order

### Phase 1 Files
```
mcp/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts
    ├── server.ts
    └── runtime.ts
```

### Phase 2 Files
```
mcp/src/tools/
├── index.ts
├── incidents.ts
├── changes.ts
├── analysis.ts
└── ado.ts
```

### Phase 3 Files
```
mcp/src/resources/
├── index.ts
├── incidents.ts
├── changes.ts
└── dashboards.ts
```

### Phase 4 Files
```
mcp/src/prompts/
├── index.ts
├── triage.ts
├── handover.ts
├── changeReview.ts
└── postmortem.ts
```

### Phase 5 Files
```
mcp/
├── README.md
└── tests/
    └── tools.test.ts
```

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| MCP SDK API changes | Pin specific version in package.json |
| ServiceNow auth in MCP context | Test with existing credentials early |
| Path resolution for imports | Use tsconfig paths, test early |
| Copilot CLI config complexity | Provide working example config |

---

## Definition of Done

- [ ] `npm run build` succeeds in `mcp/` directory
- [ ] Server starts without errors
- [ ] All 9 tools respond correctly in Copilot CLI
- [ ] All 5 resources are browsable
- [ ] All 4 prompts appear in prompt picker
- [ ] README documents setup and usage
- [ ] At least one test file exists

---

## Quick Start After Implementation

```bash
# Build
cd mcp && npm install && npm run build

# Configure Copilot CLI
# Add to ~/.config/github-copilot/mcp.json

# Test
copilot "Show me open P1 incidents"
copilot "What's at risk of SLA breach?"
copilot "Create a bug for INC0012345"
```

---

## Ready to Start?

Phase 1 can begin immediately. Should I proceed with implementation?
