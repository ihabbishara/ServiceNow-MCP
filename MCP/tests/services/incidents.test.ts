import { describe, it, expect, vi } from "vitest";
import { IncidentService } from "../../src/services/incidents.js";
import { SlaRiskService } from "../../src/services/slaRisk.js";
import { StaleTicketService } from "../../src/services/staleTickets.js";
import { ChangeCorrelationService } from "../../src/services/correlation.js";
import { ServiceNowClient } from "../../src/clients/servicenow.js";
import { AzureDevOpsClient } from "../../src/clients/ado.js";
import { Incident, ChangeRecord } from "../../src/types.js";

const incident: Incident = {
  number: "INC0001", sysId: "x", priority: "1", state: "New", shortDescription: "DB down",
  openedAt: "2026-06-11T10:00:00Z", updatedAt: "2026-06-11T10:00:00Z", cmdbCi: "db-prod-01"
};

const relatedChange: ChangeRecord = {
  number: "CHG0001", sysId: "c", state: "Closed", shortDescription: "patch",
  cmdbCi: "db-prod-01", actualStartDate: "2026-06-11T09:00:00Z"
};

const window = { beforeHours: 24, afterHours: 4 };

const makeService = (overrides: {
  sn?: Partial<ServiceNowClient>;
  ado?: Partial<AzureDevOpsClient>;
} = {}) => {
  const sn = {
    getIncidentByNumber: vi.fn().mockResolvedValue(incident),
    listIncidents: vi.fn().mockResolvedValue([incident]),
    listChangesWithFilters: vi.fn().mockResolvedValue([relatedChange]),
    ...overrides.sn
  } as unknown as ServiceNowClient;
  const ado = {
    searchWorkItems: vi.fn().mockResolvedValue([{ id: 42, title: "[INC0001] DB down", state: "Active" }]),
    ...overrides.ado
  } as unknown as AzureDevOpsClient;
  return {
    sn, ado,
    svc: new IncidentService(sn, ado, new SlaRiskService(), new StaleTicketService({ "1": 30 }),
      new ChangeCorrelationService(window), window)
  };
};

describe("IncidentService", () => {
  it("summarizeIncident combines incident, correlated changes, and ADO items", async () => {
    const { svc, sn } = makeService();
    const result = await svc.summarizeIncident("INC0001");
    expect(result.incident.number).toBe("INC0001");
    expect(result.relatedChanges[0].changeNumber).toBe("CHG0001");
    expect(result.relatedWorkItems[0].id).toBe(42);
    // change candidates fetched from a window starting beforeHours before openedAt
    expect((sn.listChangesWithFilters as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({
      startedAfter: "2026-06-10T10:00:00.000Z", limit: 200
    });
  });

  it("summarizeIncident throws when incident not found", async () => {
    const { svc } = makeService({ sn: { getIncidentByNumber: vi.fn().mockResolvedValue(null) } });
    await expect(svc.summarizeIncident("INC9999")).rejects.toThrow(/INC9999 not found/);
  });

  it("summarizeIncident survives ADO search failure", async () => {
    const { svc } = makeService({ ado: { searchWorkItems: vi.fn().mockRejectedValue(new Error("ADO down")) } });
    const result = await svc.summarizeIncident("INC0001");
    expect(result.relatedWorkItems).toEqual([]);
    expect(result.relatedChanges).toHaveLength(1);
  });

  it("listSlaRisks filters by priorities client-side", async () => {
    const p2 = { ...incident, number: "INC-P2", priority: "2", slaDue: "2026-06-11T10:30:00Z" };
    const { svc } = makeService({ sn: { listIncidents: vi.fn().mockResolvedValue([incident, p2]) } });
    const risks = await svc.listSlaRisks({ onlyOpen: true, priorities: ["2"] });
    expect(risks.every((r) => r.priority === "2")).toBe(true);
  });

  it("listStaleIncidents delegates to stale service over open incidents", async () => {
    const staleInc = { ...incident, updatedAt: "2026-06-11T00:00:00Z" };
    const { svc, sn } = makeService({ sn: { listIncidents: vi.fn().mockResolvedValue([staleInc]) } });
    const stale = await svc.listStaleIncidents({ onlyOpen: true, assignmentGroup: "Platform SRE" });
    expect(stale).toHaveLength(1);
    expect((sn.listIncidents as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual({
      onlyOpen: true, assignmentGroup: "Platform SRE"
    });
  });
});
