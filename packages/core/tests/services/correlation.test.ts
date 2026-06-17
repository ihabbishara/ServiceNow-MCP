import { describe, it, expect } from "vitest";
import { ChangeCorrelationService } from "../../src/services/correlation.js";
import { Incident, ChangeRecord } from "../../src/types.js";

const svc = new ChangeCorrelationService({ beforeHours: 24, afterHours: 4 });

const incident: Incident = {
  number: "INC0001",
  sysId: "x",
  priority: "1",
  state: "New",
  shortDescription: "DB down",
  openedAt: "2026-06-11T10:00:00Z",
  updatedAt: "2026-06-11T10:00:00Z",
  cmdbCi: "db-prod-01",
  businessService: "Payments",
  assignmentGroup: "Platform SRE"
};

const change = (overrides: Partial<ChangeRecord>): ChangeRecord => ({
  number: "CHG0001",
  sysId: "c",
  state: "Closed",
  shortDescription: "patch",
  actualStartDate: "2026-06-11T09:00:00Z",
  ...overrides
});

describe("ChangeCorrelationService", () => {
  it("honors a per-call window override", () => {
    // change 3h after open: inside the default 4h after-window, outside a 1h override
    const c = change({ cmdbCi: "db-prod-01", actualStartDate: "2026-06-11T13:00:00Z" });
    expect(svc.correlate(incident, [c])).toHaveLength(1);
    expect(svc.correlate(incident, [c], { beforeHours: 24, afterHours: 1 })).toHaveLength(0);
  });

  it("scores CI + service + group + time proximity matches", () => {
    const result = svc.correlate(incident, [
      change({
        cmdbCi: "db-prod-01",
        businessService: "Payments",
        assignmentGroup: "Platform SRE"
      })
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].confidenceScore).toBe(1); // 0.5+0.25+0.15+0.1
    expect(result[0].correlationReason).toContain("same configuration item");
  });

  it("excludes changes outside the time window", () => {
    expect(
      svc.correlate(incident, [
        change({
          cmdbCi: "db-prod-01",
          actualStartDate: "2026-06-09T09:00:00Z" // 49h before
        })
      ])
    ).toHaveLength(0);
    expect(
      svc.correlate(incident, [
        change({
          cmdbCi: "db-prod-01",
          actualStartDate: "2026-06-11T15:00:00Z" // 5h after
        })
      ])
    ).toHaveLength(0);
  });

  it("excludes weak matches below 0.25", () => {
    // only assignment group (0.15) and outside ±2h proximity → 0.15 < 0.25
    expect(
      svc.correlate(incident, [
        change({
          assignmentGroup: "Platform SRE",
          actualStartDate: "2026-06-11T05:00:00Z"
        })
      ])
    ).toHaveLength(0);
  });

  it("matches CI case-insensitively", () => {
    const result = svc.correlate(incident, [change({ cmdbCi: "DB-PROD-01" })]);
    expect(result).toHaveLength(1);
    expect(result[0].correlationReason).toContain("same configuration item");
  });

  it("falls back to plannedStartDate when no actual start", () => {
    const result = svc.correlate(incident, [
      change({
        actualStartDate: undefined,
        plannedStartDate: "2026-06-11T09:00:00Z",
        cmdbCi: "db-prod-01"
      })
    ]);
    expect(result).toHaveLength(1);
  });

  it("sorts by confidence descending", () => {
    const result = svc.correlate(incident, [
      change({
        number: "CHG-WEAK",
        businessService: "Payments",
        actualStartDate: "2026-06-11T01:00:00Z"
      }),
      change({
        number: "CHG-STRONG",
        cmdbCi: "db-prod-01",
        businessService: "Payments"
      })
    ]);
    expect(result.map((r) => r.changeNumber)).toEqual(["CHG-STRONG", "CHG-WEAK"]);
  });
});
