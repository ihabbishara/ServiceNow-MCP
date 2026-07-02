import { describe, it, expect } from "vitest";
import { escapeWiql, searchConditions } from "../../src/clients/ado/wiql.js";
import { workItemFieldOps } from "../../src/clients/ado/fields.js";

describe("searchConditions", () => {
  it("escapes quotes and builds all five filters in order", () => {
    expect(
      searchConditions({
        text: "o'hare",
        workItemType: "Bug",
        state: "Active",
        areaPath: "Proj\\Team",
        assignedTo: "me@x.com"
      })
    ).toEqual([
      "[System.Title] CONTAINS 'o''hare'",
      "[System.WorkItemType] = 'Bug'",
      "[System.State] = 'Active'",
      "[System.AreaPath] UNDER 'Proj\\Team'",
      "[System.AssignedTo] = 'me@x.com'"
    ]);
  });

  it("maps @Me to the WIQL macro unquoted", () => {
    expect(searchConditions({ assignedTo: "@Me" })).toEqual(["[System.AssignedTo] = @Me"]);
  });

  it("returns [] for no filters", () => {
    expect(searchConditions({})).toEqual([]);
  });

  it("escapeWiql doubles single quotes", () => {
    expect(escapeWiql("a'b''c")).toBe("a''b''''c");
  });
});

describe("workItemFieldOps", () => {
  it("routes Bug descriptions to ReproSteps as HTML", () => {
    expect(workItemFieldOps({ type: "Bug", title: "t", description: "l1\nl2" })).toEqual([
      { referenceName: "Microsoft.VSTS.TCM.ReproSteps", value: "l1<br>l2" }
    ]);
  });

  it("maps tags, valid priority, story points, and extra fields", () => {
    expect(
      workItemFieldOps({
        type: "Task",
        title: "t",
        tags: ["a", "b"],
        priority: "2",
        storyPoints: 5,
        fields: { "Custom.Field": "v" }
      })
    ).toEqual([
      { referenceName: "System.Tags", value: "a; b" },
      { referenceName: "Microsoft.VSTS.Common.Priority", value: 2 },
      { referenceName: "Microsoft.VSTS.Scheduling.StoryPoints", value: 5 },
      { referenceName: "Custom.Field", value: "v" }
    ]);
  });

  it("drops an out-of-range priority", () => {
    expect(workItemFieldOps({ type: "Task", title: "t", priority: "9" })).toEqual([]);
  });
});
