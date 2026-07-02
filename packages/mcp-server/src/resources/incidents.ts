import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpRuntime, Incident } from "@sre/core";
import { safeResource } from "./util.js";

const formatIncidentAsMarkdown = (incident: Incident): string => {
  const timeline = [
    `- **Opened:** ${incident.openedAt}`,
    `- **Last Updated:** ${incident.updatedAt}`,
    incident.resolvedAt ? `- **Resolved:** ${incident.resolvedAt}` : null,
    incident.slaDue ? `- **SLA Due:** ${incident.slaDue}` : null
  ]
    .filter(Boolean)
    .join("\n");

  // ServiceNow returns the journal (work_notes/comments) as a single concatenated
  // history blob, not discrete entries — render as a block rather than a numbered list.
  const workNotes =
    incident.workNotes && incident.workNotes.length > 0
      ? incident.workNotes.join("\n\n")
      : "_No work notes available_";

  const comments =
    incident.comments && incident.comments.length > 0
      ? incident.comments.join("\n\n")
      : "_No comments available_";

  return `# Incident ${incident.number}

## Overview
- **Priority:** ${incident.priority}
- **State:** ${incident.state}
- **Assigned To:** ${incident.assignedTo ?? "Unassigned"}
- **Assignment Group:** ${incident.assignmentGroup ?? "N/A"}
- **Business Service:** ${incident.businessService ?? "N/A"}
- **Configuration Item:** ${incident.cmdbCi ?? "N/A"}

## Description
${incident.shortDescription}

${incident.description ?? ""}

## Timeline
${timeline}

## Work Notes
${workNotes}

## Comments
${comments}
`;
};

export const registerIncidentResources = (server: McpServer, runtime: McpRuntime): void => {
  // Resource template for incident://INC*
  server.resource(
    "incident",
    new ResourceTemplate("incident://{number}", { list: undefined }),
    safeResource(async (uri, variables) => {
      const number = decodeURIComponent(String(variables.number));
      const incident = await runtime.serviceNowClient.getIncidentByNumber(number);

      if (!incident) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "text/plain",
              text: `Incident ${number} not found`
            }
          ]
        };
      }

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/markdown",
            text: formatIncidentAsMarkdown(incident)
          }
        ]
      };
    })
  );
};

export const registerTeamResources = (server: McpServer, runtime: McpRuntime): void => {
  // Resource template for team://{name}/incidents
  server.resource(
    "team-incidents",
    new ResourceTemplate("team://{name}/incidents", { list: undefined }),
    safeResource(async (uri, variables) => {
      const teamName = decodeURIComponent(String(variables.name));

      // Fetch the team's open incidents once, then run the pure assessors over that
      // same list — listSlaRisks/listStaleIncidents would each re-fetch the incidents.
      const incidents = await runtime.serviceNowClient.listIncidents({
        onlyOpen: true,
        assignmentGroup: teamName
      });
      const slaRisks = runtime.slaRiskService.assess(incidents);
      const staleTickets = runtime.staleTicketService.findStale(incidents);

      // Group by priority
      const byPriority: Record<string, Incident[]> = {};
      for (const inc of incidents) {
        const p = inc.priority || "Unknown";
        if (!byPriority[p]) byPriority[p] = [];
        byPriority[p].push(inc);
      }

      let markdown = `# ${teamName} Team - Open Incidents

**Total:** ${incidents.length} open incidents

`;

      // Incidents by priority
      for (const priority of ["1", "2", "3", "4"]) {
        const priorityIncidents = byPriority[priority] || [];
        if (priorityIncidents.length === 0) continue;

        const label = {
          "1": "Critical (P1)",
          "2": "High (P2)",
          "3": "Medium (P3)",
          "4": "Low (P4)"
        }[priority];
        markdown += `## ${label} - ${priorityIncidents.length} incidents

| Number | Description | Assigned | Updated |
|--------|-------------|----------|---------|
`;
        for (const inc of priorityIncidents.slice(0, 10)) {
          markdown += `| ${inc.number} | ${inc.shortDescription.slice(0, 50)} | ${inc.assignedTo ?? "Unassigned"} | ${inc.updatedAt} |\n`;
        }
        markdown += "\n";
      }

      // SLA Risks
      if (slaRisks.length > 0) {
        markdown += `## SLA Risks

`;
        for (const risk of slaRisks.slice(0, 5)) {
          const emoji =
            risk.riskLevel === "Critical" ? "🔴" : risk.riskLevel === "High" ? "🟠" : "🟡";
          markdown += `- ${emoji} ${risk.incidentNumber}: ${risk.remainingMinutes} minutes remaining\n`;
        }
        markdown += "\n";
      }

      // Stale Tickets
      if (staleTickets.length > 0) {
        markdown += `## Stale Tickets

`;
        for (const ticket of staleTickets.slice(0, 5)) {
          markdown += `- ${ticket.incidentNumber}: No update for ${ticket.staleByMinutes} minutes (threshold: ${ticket.thresholdMinutes}m)\n`;
        }
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
