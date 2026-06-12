import { ChangeRecord, Incident, RelatedChange } from "../types.js";

const HOUR_MS = 3_600_000;

export class ChangeCorrelationService {
  constructor(private readonly window: { beforeHours: number; afterHours: number }) {}

  correlate(incident: Incident, changes: ChangeRecord[]): RelatedChange[] {
    const openedMs = Date.parse(incident.openedAt);
    if (!Number.isFinite(openedMs)) return [];
    const windowStart = openedMs - this.window.beforeHours * HOUR_MS;
    const windowEnd = openedMs + this.window.afterHours * HOUR_MS;

    const related: RelatedChange[] = [];
    for (const change of changes) {
      const startRaw = change.actualStartDate ?? change.plannedStartDate;
      if (!startRaw) continue;
      const startMs = Date.parse(startRaw);
      if (!Number.isFinite(startMs) || startMs < windowStart || startMs > windowEnd) continue;

      let score = 0;
      const reasons: string[] = [];
      if (incident.cmdbCi && change.cmdbCi === incident.cmdbCi) {
        score += 0.5;
        reasons.push("same configuration item");
      }
      if (incident.businessService && change.businessService === incident.businessService) {
        score += 0.25;
        reasons.push("same business service");
      }
      if (incident.assignmentGroup && change.assignmentGroup === incident.assignmentGroup) {
        score += 0.15;
        reasons.push("same assignment group");
      }
      if (Math.abs(startMs - openedMs) <= 2 * HOUR_MS) {
        score += 0.1;
        reasons.push("started within 2h of incident");
      }
      if (score < 0.25) continue;

      related.push({
        changeNumber: change.number,
        shortDescription: change.shortDescription,
        state: change.state,
        risk: change.risk,
        plannedStart: change.plannedStartDate,
        actualStart: change.actualStartDate,
        correlationReason: reasons.join("; "),
        confidenceScore: Math.min(1, Number(score.toFixed(2)))
      });
    }
    return related.sort((a, b) => b.confidenceScore - a.confidenceScore);
  }
}
