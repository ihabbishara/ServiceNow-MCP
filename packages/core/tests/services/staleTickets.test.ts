import { describe, it, expect } from "vitest";
import { StaleTicketService } from "../../src/services/staleTickets.js";
import { Incident } from "../../src/types.js";

const thresholds = { "1": 30, "2": 120, "3": 1440, "4": 4320 };
const svc = new StaleTicketService(thresholds);
const now = new Date("2026-06-11T12:00:00Z");

const incident = (number: string, priority: string, updatedAt: string): Incident => ({
  number,
  sysId: "x",
  priority,
  state: "In Progress",
  shortDescription: "t",
  openedAt: "2026-06-11T00:00:00Z",
  updatedAt
});

describe("StaleTicketService", () => {
  it("flags tickets past their priority threshold with overshoot minutes", () => {
    // P1, threshold 30 min, last update 100 min ago → stale by 70
    const result = svc.findStale([incident("INC1", "1", "2026-06-11T10:20:00Z")], now);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      incidentNumber: "INC1",
      staleByMinutes: 70,
      thresholdMinutes: 30
    });
  });

  it("does not flag tickets within threshold", () => {
    // P2, threshold 120 min, last update 60 min ago
    expect(svc.findStale([incident("INC2", "2", "2026-06-11T11:00:00Z")], now)).toHaveLength(0);
  });

  it("skips unknown priorities", () => {
    expect(svc.findStale([incident("INC3", "5", "2026-06-01T00:00:00Z")], now)).toHaveLength(0);
  });

  it("sorts most stale first", () => {
    const result = svc.findStale(
      [
        incident("INC-A", "1", "2026-06-11T11:00:00Z"),
        incident("INC-B", "1", "2026-06-11T09:00:00Z")
      ],
      now
    );
    expect(result.map((t) => t.incidentNumber)).toEqual(["INC-B", "INC-A"]);
  });
});
