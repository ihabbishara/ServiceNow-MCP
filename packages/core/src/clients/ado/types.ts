import type { WorkItem } from "../../types.js";

export interface WorkItemSearchFilters {
  text?: string; // System.Title CONTAINS (optional)
  workItemType?: string; // 'User Story' | 'Task' | 'Bug' | 'Issue'
  state?: string;
  areaPath?: string; // System.AreaPath UNDER
  assignedTo?: string; // email/display, or '@Me'
  limit?: number; // default 50, max 200
}

export interface CreateBugPayload {
  title: string;
  description: string;
  areaPath?: string;
  iterationPath?: string;
  tags?: string[];
  assignedTeam?: string;
  priority?: string; // "1".."4"
  incidentNumber: string; // included in the title by the caller; not written as a separate ADO field
}

export interface AzureDevOpsClient {
  searchWorkItems(f: WorkItemSearchFilters): Promise<WorkItem[]>;
  getWorkItem(id: number): Promise<WorkItem | null>;
  createBug(p: CreateBugPayload): Promise<{ id: number; title: string }>;
}
