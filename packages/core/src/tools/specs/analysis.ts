import { z } from "zod";
import { ToolError, defineSpec } from "../spec.js";

export const analysisSpecs = [
  defineSpec({
    name: "find_sla_risks",
    description:
      "Find open incidents at risk of SLA breach. Risk levels: Critical (<10% time), High (<25%), Medium (<50%)",
    schema: {
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
    run: async (rt, a) => {
      const risks = await rt.incidentService.listSlaRisks({
        onlyOpen: true,
        assignmentGroup: a.assignment_group,
        priorities: a.priorities
      });

      let filteredRisks = risks;
      if (a.risk_level) {
        const riskOrder = { Critical: 0, High: 1, Medium: 2 };
        const minLevel = riskOrder[a.risk_level];
        filteredRisks = risks.filter((r) => riskOrder[r.riskLevel] <= minLevel);
      }

      return {
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
    }
  }),

  defineSpec({
    name: "find_stale_tickets",
    description:
      "Find tickets not updated within expected thresholds. Thresholds: P1=30min, P2=2h, P3=24h, P4=72h",
    schema: {
      assignment_group: z.string().optional().describe("Filter to specific team"),
      priorities: z
        .array(z.enum(["1", "2", "3", "4"]))
        .optional()
        .describe("Filter to specific priorities")
    },
    run: async (rt, a) => {
      const staleTickets = await rt.incidentService.listStaleIncidents({
        onlyOpen: true,
        assignmentGroup: a.assignment_group,
        priorities: a.priorities
      });

      return {
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
    }
  }),

  defineSpec({
    name: "generate_ops_summary",
    description:
      "Generate a daily operations summary with key metrics, risks, and recommended actions",
    schema: {
      date: z.string().optional().describe("Date for summary (ISO 8601, default: today)"),
      assignment_group: z.string().optional().describe("Focus on specific team")
    },
    run: async (rt, a) => {
      let now: Date | undefined;
      if (a.date) {
        const parsed = new Date(a.date);
        if (Number.isNaN(parsed.getTime())) {
          throw new ToolError(`Invalid date: ${a.date}. Use ISO 8601, e.g. 2026-06-11.`);
        }
        now = parsed;
      }
      const report = await rt.reportService.generateDailyOpsReport({
        now,
        assignmentGroup: a.assignment_group
      });

      return {
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
    }
  })
];
