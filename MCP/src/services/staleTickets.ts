import { Incident, StaleTicketItem } from "../types.js";

export class StaleTicketService {
  constructor(private readonly thresholdsByPriority: Record<string, number>) {}

  findStale(incidents: Incident[], now: Date = new Date()): StaleTicketItem[] {
    const items: StaleTicketItem[] = [];
    for (const inc of incidents) {
      const thresholdMinutes = this.thresholdsByPriority[inc.priority];
      if (!thresholdMinutes) continue;
      const updated = Date.parse(inc.updatedAt);
      if (!Number.isFinite(updated)) continue;

      const idleMinutes = Math.floor((now.getTime() - updated) / 60000);
      if (idleMinutes <= thresholdMinutes) continue;

      items.push({
        incidentNumber: inc.number,
        priority: inc.priority,
        assignmentGroup: inc.assignmentGroup,
        lastUpdated: inc.updatedAt,
        staleByMinutes: idleMinutes - thresholdMinutes,
        thresholdMinutes
      });
    }
    return items.sort((a, b) => b.staleByMinutes - a.staleByMinutes);
  }
}
