export interface Incident {
  number: string;
  sysId: string;
  priority: string; // "1".."4" (raw value, not display label)
  state: string; // display value, e.g. "In Progress"
  shortDescription: string;
  description?: string;
  assignedTo?: string;
  assignmentGroup?: string;
  businessService?: string;
  cmdbCi?: string;
  openedAt: string; // ISO 8601 UTC
  updatedAt: string;
  resolvedAt?: string;
  slaDue?: string;
  workNotes?: string[];
  comments?: string[];
}

export interface ChangeRecord {
  number: string;
  sysId: string;
  state: string;
  type?: string;
  risk?: string;
  impact?: string;
  shortDescription: string;
  description?: string;
  assignedTo?: string;
  assignmentGroup?: string;
  businessService?: string;
  cmdbCi?: string;
  plannedStartDate?: string;
  plannedEndDate?: string;
  actualStartDate?: string;
  actualEndDate?: string;
  implementationPlan?: string;
  backoutPlan?: string;
  testPlan?: string;
  closeCode?: string;
  closeNotes?: string;
}

export interface RelatedChange {
  changeNumber: string;
  shortDescription: string;
  state: string;
  risk?: string;
  plannedStart?: string;
  actualStart?: string;
  correlationReason: string;
  confidenceScore: number; // 0..1
}

export type SlaRiskLevel = "Critical" | "High" | "Medium";

export interface SlaRiskItem {
  incidentNumber: string;
  priority: string;
  assignmentGroup?: string;
  slaDue: string;
  remainingMinutes: number; // negative when already breached
  riskLevel: SlaRiskLevel;
  suggestedAction: string;
}

export interface StaleTicketItem {
  incidentNumber: string;
  priority: string;
  assignmentGroup?: string;
  lastUpdated: string;
  staleByMinutes: number; // minutes past the threshold
  thresholdMinutes: number;
}

export interface WorkItem {
  id: number;
  title: string;
  state: string;
  assignedTo?: string;
  areaPath?: string;
  tags?: string[];
}

export interface DailyOpsReport {
  generatedAt: string;
  generatedForDate: string; // YYYY-MM-DD
  executiveSummary: string;
  openIncidentsByPriority: Record<string, number>;
  slaRisks: SlaRiskItem[];
  staleIncidents: StaleTicketItem[];
  majorIncidents: Incident[];
  failedOrHighRiskChanges: ChangeRecord[];
  upcomingChanges: ChangeRecord[];
  recommendedActions: string[];
}
