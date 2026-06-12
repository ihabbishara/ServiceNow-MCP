import { DailyOpsReport } from "../types.js";
import { ServiceNowClient } from "../clients/servicenow.js";
import { IncidentService } from "./incidents.js";

const HOUR_MS = 3_600_000;

export class ReportService {
  constructor(
    private readonly incidents: IncidentService,
    private readonly serviceNow: ServiceNowClient
  ) {}

  async generateDailyOpsReport(now: Date = new Date()): Promise<DailyOpsReport> {
    const open = await this.serviceNow.listIncidents({ onlyOpen: true });
    const slaRisks = await this.incidents.listSlaRisks({ onlyOpen: true });
    const staleIncidents = await this.incidents.listStaleIncidents({ onlyOpen: true });
    const dayAgo = new Date(now.getTime() - 24 * HOUR_MS).toISOString();
    const recentChanges = await this.serviceNow.listChangesWithFilters({ startedAfter: dayAgo, limit: 200 });

    const openIncidentsByPriority: Record<string, number> = {};
    for (const i of open) {
      openIncidentsByPriority[i.priority] = (openIncidentsByPriority[i.priority] ?? 0) + 1;
    }

    const majorIncidents = open.filter((i) => i.priority === "1");
    const failedOrHighRiskChanges = recentChanges.filter(
      (c) => c.risk?.toLowerCase() === "high" || ["failed", "cancelled", "canceled"].includes(c.state.toLowerCase())
    );
    const upcomingChanges = recentChanges.filter((c) => {
      const start = c.plannedStartDate ? Date.parse(c.plannedStartDate) : NaN;
      return Number.isFinite(start) && start > now.getTime() && start <= now.getTime() + 24 * HOUR_MS;
    });

    const recommendedActions = [
      ...slaRisks.slice(0, 5).map((r) => `${r.incidentNumber}: ${r.suggestedAction}`),
      ...staleIncidents
        .filter((t) => t.priority === "1" || t.priority === "2")
        .slice(0, 5)
        .map((t) => `${t.incidentNumber}: add work notes — ${t.staleByMinutes} min past update threshold`)
    ];

    const executiveSummary =
      `${open.length} open incidents (${majorIncidents.length} P1). ` +
      `${slaRisks.length} at SLA risk, ${staleIncidents.length} stale. ` +
      `${failedOrHighRiskChanges.length} failed/high-risk changes in the last 24h, ` +
      `${upcomingChanges.length} changes planned in the next 24h.`;

    return {
      generatedAt: now.toISOString(),
      generatedForDate: now.toISOString().slice(0, 10),
      executiveSummary,
      openIncidentsByPriority,
      slaRisks,
      staleIncidents,
      majorIncidents,
      failedOrHighRiskChanges,
      upcomingChanges,
      recommendedActions
    };
  }
}
