import { describe, it, expect } from "vitest";
import { SlaRiskService } from "../../src/services/slaRisk.js";
import { Incident } from "../../src/types.js";

// 100-minute SLA window: opened 10:00, due 11:40
const baseIncident = (overrides: Partial<Incident>): Incident => ({
  number: "INC0001",
  sysId: "x",
  priority: "1",
  state: "In Progress",
  shortDescription: "test",
  openedAt: "2026-06-11T10:00:00Z",
  updatedAt: "2026-06-11T10:00:00Z",
  slaDue: "2026-06-11T11:40:00Z",
  ...overrides
});

const svc = new SlaRiskService();

describe("SlaRiskService", () => {
  it("classifies by remaining percentage of the SLA window", () => {
    // now = 11:35 → 5 of 100 min left = 5% → Critical
    expect(svc.assess([baseIncident({})], new Date("2026-06-11T11:35:00Z"))[0].riskLevel).toBe(
      "Critical"
    );
    // now = 11:20 → 20% → High
    expect(svc.assess([baseIncident({})], new Date("2026-06-11T11:20:00Z"))[0].riskLevel).toBe(
      "High"
    );
    // now = 11:00 → 40% → Medium
    expect(svc.assess([baseIncident({})], new Date("2026-06-11T11:00:00Z"))[0].riskLevel).toBe(
      "Medium"
    );
    // now = 10:30 → 70% → not at risk
    expect(svc.assess([baseIncident({})], new Date("2026-06-11T10:30:00Z"))).toHaveLength(0);
  });

  it("treats breached SLA as Critical with negative remaining minutes", () => {
    const result = svc.assess([baseIncident({})], new Date("2026-06-11T12:00:00Z"));
    expect(result[0].riskLevel).toBe("Critical");
    expect(result[0].remainingMinutes).toBe(-20);
  });

  it("skips incidents without slaDue or with invalid window", () => {
    expect(svc.assess([baseIncident({ slaDue: undefined })], new Date())).toHaveLength(0);
    expect(svc.assess([baseIncident({ slaDue: "2026-06-11T09:00:00Z" })], new Date())).toHaveLength(
      0
    ); // due before opened
  });

  it("sorts most urgent first and fills suggestedAction", () => {
    const urgent = baseIncident({ number: "INC-URGENT" });
    const later = baseIncident({
      number: "INC-LATER",
      slaDue: "2026-06-11T12:30:00Z",
      openedAt: "2026-06-11T11:30:00Z"
    });
    const result = svc.assess([later, urgent], new Date("2026-06-11T11:35:00Z"));
    expect(result[0].incidentNumber).toBe("INC-URGENT");
    expect(result[0].suggestedAction).toMatch(/escalate/i);
  });
});
