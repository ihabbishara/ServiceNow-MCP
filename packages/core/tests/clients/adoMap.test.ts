import { describe, it, expect } from "vitest";
import { mapAzWorkItem } from "../../src/clients/ado/map.js";

describe("mapAzWorkItem", () => {
  it("maps fields, picks uniqueName, and reads dotted keys", () => {
    const raw = {
      id: 8533637,
      url: "https://dev.azure.com/INGCDaaS/_apis/wit/workItems/8533637",
      fields: {
        "System.Title": "PSS SRE Dashboard as a Service",
        "System.WorkItemType": "User Story",
        "System.State": "Active",
        "System.AreaPath": "IngOne\\P33421-PSSSRE",
        "System.IterationPath": "IngOne\\T30775-PSSSRE",
        "Microsoft.VSTS.Common.Priority": 2,
        "Microsoft.VSTS.Scheduling.StoryPoints": 8,
        "System.Parent": 8599125,
        "System.AssignedTo": {
          displayName: "Balachandran, B. (Bipin)",
          uniqueName: "bipin.balachandran@ing.com"
        }
      }
    };
    expect(mapAzWorkItem(raw)).toEqual({
      id: 8533637,
      title: "PSS SRE Dashboard as a Service",
      workItemType: "User Story",
      state: "Active",
      areaPath: "IngOne\\P33421-PSSSRE",
      iterationPath: "IngOne\\T30775-PSSSRE",
      priority: 2,
      storyPoints: 8,
      parentId: 8599125,
      assignedTo: "bipin.balachandran@ing.com",
      tags: undefined,
      url: "https://dev.azure.com/INGCDaaS/_apis/wit/workItems/8533637"
    });
  });

  it("guards absent assignee and missing tags; splits tags when present", () => {
    const raw = {
      id: 1,
      fields: { "System.Title": "t", "System.State": "New", "System.Tags": "sre; pager" }
    };
    const m = mapAzWorkItem(raw);
    expect(m.assignedTo).toBeUndefined();
    expect(m.tags).toEqual(["sre", "pager"]);
  });

  it("falls back to displayName when uniqueName is absent", () => {
    const raw = {
      id: 2,
      fields: {
        "System.Title": "t",
        "System.State": "New",
        "System.AssignedTo": { displayName: "Jane Doe" }
      }
    };
    expect(mapAzWorkItem(raw).assignedTo).toBe("Jane Doe");
  });
});
