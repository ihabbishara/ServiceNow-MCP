import type { WorkItem } from "../../types.js";

interface AzAssignee {
  displayName?: string;
  uniqueName?: string;
}

export interface AzWorkItemRaw {
  id: number;
  url?: string;
  fields?: Record<string, unknown> & {
    "System.Title"?: string;
    "System.State"?: string;
    "System.WorkItemType"?: string;
    "System.AreaPath"?: string;
    "System.IterationPath"?: string;
    "System.Parent"?: number;
    "System.Tags"?: string;
    "System.AssignedTo"?: AzAssignee;
    "Microsoft.VSTS.Common.Priority"?: number;
    "Microsoft.VSTS.Scheduling.StoryPoints"?: number;
  };
}

export const mapAzWorkItem = (raw: AzWorkItemRaw): WorkItem => {
  const f = raw.fields ?? {};
  const assignee = f["System.AssignedTo"];
  const tags = f["System.Tags"];
  return {
    id: raw.id,
    title: f["System.Title"] ?? "",
    workItemType: f["System.WorkItemType"],
    state: f["System.State"] ?? "",
    areaPath: f["System.AreaPath"],
    iterationPath: f["System.IterationPath"],
    priority: f["Microsoft.VSTS.Common.Priority"],
    storyPoints: f["Microsoft.VSTS.Scheduling.StoryPoints"],
    parentId: f["System.Parent"],
    assignedTo: assignee?.uniqueName ?? assignee?.displayName,
    tags: tags ? tags.split(/;\s*/).map((t) => t.trim()).filter(Boolean) : undefined,
    url: raw.url
  };
};
