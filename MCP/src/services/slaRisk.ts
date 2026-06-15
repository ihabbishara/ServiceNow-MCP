import { Incident, SlaRiskItem, SlaRiskLevel } from "../types.js";

const ACTIONS: Record<SlaRiskLevel, string> = {
  Critical: "Escalate immediately — SLA breach imminent or already breached",
  High: "Prioritize now and post an update on the ticket",
  Medium: "Review today and confirm the owner is actively working it"
};

export class SlaRiskService {
  assess(incidents: Incident[], now: Date = new Date()): SlaRiskItem[] {
    const items: SlaRiskItem[] = [];
    for (const inc of incidents) {
      if (!inc.slaDue) continue;
      const due = Date.parse(inc.slaDue);
      const opened = Date.parse(inc.openedAt);
      if (!Number.isFinite(due) || !Number.isFinite(opened) || due <= opened) continue;

      const remainingMs = due - now.getTime();
      const remainingPct = remainingMs / (due - opened);

      let riskLevel: SlaRiskLevel;
      if (remainingPct < 0.1) riskLevel = "Critical";
      else if (remainingPct < 0.25) riskLevel = "High";
      else if (remainingPct < 0.5) riskLevel = "Medium";
      else continue;

      items.push({
        incidentNumber: inc.number,
        priority: inc.priority,
        assignmentGroup: inc.assignmentGroup,
        slaDue: inc.slaDue,
        remainingMinutes: Math.round(remainingMs / 60000),
        riskLevel,
        suggestedAction: ACTIONS[riskLevel]
      });
    }
    return items.sort((a, b) => a.remainingMinutes - b.remainingMinutes);
  }
}
