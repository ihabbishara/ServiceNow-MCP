import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpRuntime } from "../runtime.js";
import { safeResource } from "./util.js";

export const registerDashboardResources = (server: McpServer, runtime: McpRuntime): void => {
  // SLA Dashboard resource
  server.resource(
    "sla-dashboard",
    "sla-dashboard://current",
    safeResource(async (uri) => {
      const risks = await runtime.incidentService.listSlaRisks({ onlyOpen: true });

      const critical = risks.filter((r) => r.riskLevel === "Critical");
      const high = risks.filter((r) => r.riskLevel === "High");
      const medium = risks.filter((r) => r.riskLevel === "Medium");

      let markdown = `# SLA Risk Dashboard

**Generated:** ${new Date().toISOString()}

## Summary
- 🔴 Critical Risk: ${critical.length} incidents
- 🟠 High Risk: ${high.length} incidents
- 🟡 Medium Risk: ${medium.length} incidents

`;

      if (critical.length > 0) {
        markdown += `## Critical Risk (< 10% time remaining)

| Incident | Priority | Time Remaining | Assigned To | Action |
|----------|----------|----------------|-------------|--------|
`;
        for (const r of critical) {
          markdown += `| ${r.incidentNumber} | P${r.priority} | ${r.remainingMinutes} min | ${r.assignmentGroup ?? "Unassigned"} | ${r.suggestedAction} |\n`;
        }
        markdown += "\n";
      }

      if (high.length > 0) {
        markdown += `## High Risk (< 25% time remaining)

| Incident | Priority | Time Remaining | Assigned To | Action |
|----------|----------|----------------|-------------|--------|
`;
        for (const r of high.slice(0, 10)) {
          markdown += `| ${r.incidentNumber} | P${r.priority} | ${r.remainingMinutes} min | ${r.assignmentGroup ?? "Unassigned"} | ${r.suggestedAction} |\n`;
        }
        markdown += "\n";
      }

      if (medium.length > 0) {
        markdown += `## Medium Risk (< 50% time remaining)

| Incident | Priority | Time Remaining | Assigned To |
|----------|----------|----------------|-------------|
`;
        for (const r of medium.slice(0, 10)) {
          markdown += `| ${r.incidentNumber} | P${r.priority} | ${r.remainingMinutes} min | ${r.assignmentGroup ?? "Unassigned"} |\n`;
        }
        markdown += "\n";
      }

      // Recommended actions
      if (risks.length > 0) {
        markdown += `## Recommended Actions

`;
        const urgent = risks.filter((r) => r.riskLevel === "Critical" || r.riskLevel === "High").slice(0, 5);
        for (const r of urgent) {
          markdown += `1. **${r.incidentNumber}**: ${r.suggestedAction}\n`;
        }
      } else {
        markdown += `✅ No SLA risks at this time.\n`;
      }

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/markdown",
            text: markdown
          }
        ]
      };
    })
  );

  // Stale Tickets Dashboard resource
  server.resource(
    "stale-dashboard",
    "stale-dashboard://current",
    safeResource(async (uri) => {
      const staleTickets = await runtime.incidentService.listStaleIncidents({ onlyOpen: true });

      // Group by priority
      const byPriority: Record<string, typeof staleTickets> = {};
      for (const t of staleTickets) {
        const p = t.priority || "Unknown";
        if (!byPriority[p]) byPriority[p] = [];
        byPriority[p].push(t);
      }

      let markdown = `# Stale Tickets Dashboard

**Generated:** ${new Date().toISOString()}

## Summary
**Total Stale Tickets:** ${staleTickets.length}

| Priority | Count | Threshold |
|----------|-------|-----------|
| P1 | ${(byPriority["1"] || []).length} | 30 min |
| P2 | ${(byPriority["2"] || []).length} | 2 hours |
| P3 | ${(byPriority["3"] || []).length} | 24 hours |
| P4 | ${(byPriority["4"] || []).length} | 72 hours |

`;

      for (const priority of ["1", "2", "3", "4"]) {
        const tickets = byPriority[priority] || [];
        if (tickets.length === 0) continue;

        const label = { "1": "P1 (Critical)", "2": "P2 (High)", "3": "P3 (Medium)", "4": "P4 (Low)" }[priority];
        markdown += `## ${label} - ${tickets.length} stale

| Incident | Stale By | Last Updated | Assignment Group |
|----------|----------|--------------|------------------|
`;
        for (const t of tickets.slice(0, 10)) {
          const staleByHours = Math.round(t.staleByMinutes / 60);
          const staleDisplay = staleByHours >= 1 ? `${staleByHours}h` : `${t.staleByMinutes}m`;
          markdown += `| ${t.incidentNumber} | ${staleDisplay} | ${t.lastUpdated} | ${t.assignmentGroup ?? "N/A"} |\n`;
        }
        markdown += "\n";
      }

      if (staleTickets.length === 0) {
        markdown += `✅ No stale tickets at this time.\n`;
      }

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/markdown",
            text: markdown
          }
        ]
      };
    })
  );
};
