import { describe, it, expect, vi } from "vitest";
import { ReportService } from "../../src/services/report.js";
import { IncidentService } from "../../src/services/incidents.js";
import { ServiceNowClient } from "../../src/clients/servicenow.js";
import { Incident, ChangeRecord, SlaRiskItem, StaleTicketItem } from "../../src/types.js";

const now = new Date("2026-06-11T12:00:00Z");

const inc = (number: string, priority: string): Incident => ({
  number, sysId: "x", priority, state: "In Progress", shortDescription: "t",
  openedAt: "2026-06-11T08:00:00Z", updatedAt: "2026-06-11T11:00:00Z"
});

const chg = (number: string, overrides: Partial<ChangeRecord>): ChangeRecord => ({
  number, sysId: "c", state: "Scheduled", shortDescription: "t", ...overrides
});

const slaRisk: SlaRiskItem = {
  incidentNumber: "INC-P1", priority: "1", slaDue: "2026-06-11T12:30:00Z",
  remainingMinutes: 30, riskLevel: "Critical", suggestedAction: "Escalate immediately"
};
const staleTicket: StaleTicketItem = {
  incidentNumber: "INC-STALE", priority: "2", lastUpdated: "2026-06-11T08:00:00Z",
  staleByMinutes: 60, thresholdMinutes: 120
};

describe("ReportService", () => {
  it("aggregates counts, majors, change buckets, and actions", async () => {
    const sn = {
      listIncidents: vi.fn().mockResolvedValue([inc("INC-P1", "1"), inc("INC-P2", "2"), inc("INC-P2B", "2")]),
      listChangesWithFilters: vi.fn().mockResolvedValue([
        chg("CHG-FAILED", { state: "Failed", actualStartDate: "2026-06-11T06:00:00Z" }),
        chg("CHG-HIGHRISK", { risk: "High", actualStartDate: "2026-06-11T07:00:00Z" }),
        chg("CHG-UPCOMING", { plannedStartDate: "2026-06-11T20:00:00Z" }),
        chg("CHG-NORMAL", { risk: "Low", actualStartDate: "2026-06-11T05:00:00Z" })
      ])
    } as unknown as ServiceNowClient;
    const incidents = {
      listSlaRisks: vi.fn().mockResolvedValue([slaRisk]),
      listStaleIncidents: vi.fn().mockResolvedValue([staleTicket])
    } as unknown as IncidentService;

    const report = await new ReportService(incidents, sn).generateDailyOpsReport({ now });

    expect(report.generatedForDate).toBe("2026-06-11");
    expect(report.openIncidentsByPriority).toEqual({ "1": 1, "2": 2 });
    expect(report.majorIncidents.map((i) => i.number)).toEqual(["INC-P1"]);
    expect(report.failedOrHighRiskChanges.map((c) => c.number)).toEqual(["CHG-FAILED", "CHG-HIGHRISK"]);
    expect(report.upcomingChanges.map((c) => c.number)).toEqual(["CHG-UPCOMING"]);
    expect(report.recommendedActions.some((a) => a.includes("INC-P1"))).toBe(true);
    expect(report.recommendedActions.some((a) => a.includes("INC-STALE"))).toBe(true);
    expect(report.executiveSummary).toContain("3 open incidents");
    expect(report.executiveSummary).toContain("1 P1");
  });

  it("produces a valid empty report when there is no data", async () => {
    const sn = {
      listIncidents: vi.fn().mockResolvedValue([]),
      listChangesWithFilters: vi.fn().mockResolvedValue([chg("CHG-NOPLAN", {})])
    } as unknown as ServiceNowClient;
    const incidents = {
      listSlaRisks: vi.fn().mockResolvedValue([]),
      listStaleIncidents: vi.fn().mockResolvedValue([])
    } as unknown as IncidentService;

    const report = await new ReportService(incidents, sn).generateDailyOpsReport({ now });

    expect(report.openIncidentsByPriority).toEqual({});
    expect(report.majorIncidents).toEqual([]);
    expect(report.upcomingChanges).toEqual([]); // change without plannedStartDate excluded via NaN guard
    expect(report.recommendedActions).toEqual([]);
    expect(report.executiveSummary).toContain("0 open incidents");
  });

  it("threads assignmentGroup into every underlying query", async () => {
    const listIncidents = vi.fn().mockResolvedValue([]);
    const listChangesWithFilters = vi.fn().mockResolvedValue([]);
    const sn = { listIncidents, listChangesWithFilters } as unknown as ServiceNowClient;
    const listSlaRisks = vi.fn().mockResolvedValue([]);
    const listStaleIncidents = vi.fn().mockResolvedValue([]);
    const incidents = { listSlaRisks, listStaleIncidents } as unknown as IncidentService;

    await new ReportService(incidents, sn).generateDailyOpsReport({ now, assignmentGroup: "Platform SRE" });

    expect(listIncidents).toHaveBeenCalledWith(expect.objectContaining({ assignmentGroup: "Platform SRE" }));
    expect(listSlaRisks).toHaveBeenCalledWith(expect.objectContaining({ assignmentGroup: "Platform SRE" }));
    expect(listStaleIncidents).toHaveBeenCalledWith(expect.objectContaining({ assignmentGroup: "Platform SRE" }));
    expect(listChangesWithFilters).toHaveBeenCalledWith(expect.objectContaining({ assignmentGroup: "Platform SRE" }));
  });
});
