import type { WorkItemSearchFilters } from "./types.js";

export const escapeWiql = (s: string): string => s.replace(/'/g, "''");

/** WHERE conditions for a work-item search, shared by the PAT (REST) and az-CLI clients. */
export const searchConditions = (f: WorkItemSearchFilters): string[] => {
  const where: string[] = [];
  if (f.text) where.push(`[System.Title] CONTAINS '${escapeWiql(f.text)}'`);
  if (f.workItemType) where.push(`[System.WorkItemType] = '${escapeWiql(f.workItemType)}'`);
  if (f.state) where.push(`[System.State] = '${escapeWiql(f.state)}'`);
  if (f.areaPath) where.push(`[System.AreaPath] UNDER '${escapeWiql(f.areaPath)}'`);
  if (f.assignedTo === "@Me") where.push("[System.AssignedTo] = @Me");
  else if (f.assignedTo) where.push(`[System.AssignedTo] = '${escapeWiql(f.assignedTo)}'`);
  return where;
};
