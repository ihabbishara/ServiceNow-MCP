import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { McpRuntime } from "@sre/core";

export const registerAnalysisTools = (server: McpServer, runtime: McpRuntime): void => {
  // find_sla_risks - Find incidents at risk of SLA breach
  server.tool(
    "find_sla_risks",
    "Find open incidents at risk of SLA breach. Risk levels: Critical (<10% time), High (<25%), Medium (<50%)",
    {
      assignment_group: z.string().optional().describe("Filter to specific team"),
      priorities: z
        .array(z.enum(["1", "2", "3", "4"]))
        .optional()
        .describe("Filter to specific priorities (e.g., ['1', '2'])"),
      risk_level: z
        .enum(["Critical", "High", "Medium"])
        .optional()
        .describe("Minimum risk level to include")
    },
    async (args) => {
      try {
        const risks = await runtime.incidentService.listSlaRisks({
          onlyOpen: true,
          assignmentGroup: args.assignment_group,
          priorities: args.priorities
        });

        // Filter by risk level if specified
        let filteredRisks = risks;
        if (args.risk_level) {
          const riskOrder = { Critical: 0, High: 1, Medium: 2 };
          const minLevel = riskOrder[args.risk_level];
          filteredRisks = risks.filter((r) => riskOrder[r.riskLevel] <= minLevel);
        }

        const result = {
          count: filteredRisks.length,
          risks: filteredRisks.map((r) => ({
            incidentNumber: r.incidentNumber,
            priority: r.priority,
            assignmentGroup: r.assignmentGroup,
            slaDue: r.slaDue,
            remainingMinutes: r.remainingMinutes,
            riskLevel: r.riskLevel,
            suggestedAction: r.suggestedAction
          }))
        };

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error finding SLA risks: ${error}` }],
          isError: true
        };
      }
    }
  );

  // find_stale_tickets - Find tickets not updated within thresholds
  server.tool(
    "find_stale_tickets",
    "Find tickets not updated within expected thresholds. Thresholds: P1=30min, P2=2h, P3=24h, P4=72h",
    {
      assignment_group: z.string().optional().describe("Filter to specific team"),
      priorities: z
        .array(z.enum(["1", "2", "3", "4"]))
        .optional()
        .describe("Filter to specific priorities")
    },
    async (args) => {
      try {
        const staleTickets = await runtime.incidentService.listStaleIncidents({
          onlyOpen: true,
          assignmentGroup: args.assignment_group,
          priorities: args.priorities
        });

        const result = {
          count: staleTickets.length,
          tickets: staleTickets.map((t) => ({
            incidentNumber: t.incidentNumber,
            priority: t.priority,
            assignmentGroup: t.assignmentGroup,
            lastUpdated: t.lastUpdated,
            staleByMinutes: t.staleByMinutes,
            thresholdMinutes: t.thresholdMinutes
          }))
        };

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error finding stale tickets: ${error}` }],
          isError: true
        };
      }
    }
  );

  // generate_ops_summary - Generate daily operations summary
  server.tool(
    "generate_ops_summary",
    "Generate a daily operations summary with key metrics, risks, and recommended actions",
    {
      date: z.string().optional().describe("Date for summary (ISO 8601, default: today)"),
      assignment_group: z.string().optional().describe("Focus on specific team")
    },
    async (args) => {
      try {
        let now: Date | undefined;
        if (args.date) {
          const parsed = new Date(args.date);
          if (Number.isNaN(parsed.getTime())) {
            return {
              content: [
                { type: "text", text: `Invalid date: ${args.date}. Use ISO 8601, e.g. 2026-06-11.` }
              ],
              isError: true
            };
          }
          now = parsed;
        }
        const report = await runtime.reportService.generateDailyOpsReport({
          now,
          assignmentGroup: args.assignment_group
        });

        const result = {
          generatedAt: report.generatedAt,
          generatedForDate: report.generatedForDate,
          executiveSummary: report.executiveSummary,
          openIncidentsByPriority: report.openIncidentsByPriority,
          slaRisksCount: report.slaRisks.length,
          slaRisks: report.slaRisks.slice(0, 10).map((r) => ({
            incidentNumber: r.incidentNumber,
            priority: r.priority,
            remainingMinutes: r.remainingMinutes,
            riskLevel: r.riskLevel
          })),
          staleIncidentsCount: report.staleIncidents.length,
          staleIncidents: report.staleIncidents.slice(0, 10).map((t) => ({
            incidentNumber: t.incidentNumber,
            priority: t.priority,
            staleByMinutes: t.staleByMinutes
          })),
          majorIncidentsCount: report.majorIncidents.length,
          failedOrHighRiskChangesCount: report.failedOrHighRiskChanges.length,
          upcomingChangesCount: report.upcomingChanges.length,
          recommendedActions: report.recommendedActions
        };

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error generating ops summary: ${error}` }],
          isError: true
        };
      }
    }
  );
};
