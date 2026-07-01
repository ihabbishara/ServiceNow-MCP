import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Mock } from "vitest";
import { fetch } from "undici";
import { AdoPatClient } from "../../src/clients/ado/index.js";

// Clients use undici's fetch (not Node's global fetch); mock that named export.
vi.mock("undici", async (orig) => {
  const actual = await orig<typeof import("undici")>();
  return { ...actual, fetch: vi.fn() };
});

const cfg = {
  enabled: true,
  orgUrl: "https://dev.azure.com/acme",
  project: "Platform",
  pat: "pat123",
  defaultAreaPath: "Platform",
  defaultIterationPath: "Platform",
  defaultAssignedTeam: undefined
};

const jsonResponse = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body, text: async () => "" }) as unknown as Response;

describe("AdoPatClient", () => {
  const fetchMock = fetch as unknown as Mock;
  beforeEach(() => fetchMock.mockReset());

  it("searchWorkItems posts WIQL then fetches details", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ workItems: [{ id: 42 }, { id: 43 }] }))
      .mockResolvedValueOnce(jsonResponse({
        value: [
          {
            id: 42,
            fields: {
              "System.Title": "[INC0001] DB down",
              "System.State": "Active",
              "System.AssignedTo": { displayName: "Jane Doe" },
              "System.AreaPath": "Platform\\SRE",
              "System.Tags": "ServiceNow; Incident"
            }
          },
          { id: 43, fields: { "System.Title": "Other", "System.State": "New" } }
        ]
      }));

    const client = new AdoPatClient(cfg);
    const items = await client.searchWorkItems({ text: "INC0001", workItemType: "Bug", state: "Active" });

    const [wiqlUrl, wiqlInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(wiqlUrl).toBe("https://dev.azure.com/acme/Platform/_apis/wit/wiql?api-version=7.1&$top=50");
    expect(JSON.parse(wiqlInit.body as string).query).toBe(
      "SELECT [System.Id] FROM WorkItems WHERE [System.Title] CONTAINS 'INC0001' AND [System.WorkItemType] = 'Bug' AND [System.State] = 'Active' ORDER BY [System.ChangedDate] DESC"
    );
    expect((wiqlInit.headers as Record<string, string>).Authorization).toBe(
      "Basic " + Buffer.from(":pat123").toString("base64")
    );

    const detailsUrl = fetchMock.mock.calls[1][0] as string;
    expect(detailsUrl).toContain("/_apis/wit/workitems?ids=42,43");

    expect(items[0]).toEqual({
      id: 42,
      title: "[INC0001] DB down",
      state: "Active",
      assignedTo: "Jane Doe",
      areaPath: "Platform\\SRE",
      tags: ["ServiceNow", "Incident"]
    });
    expect(items[1].assignedTo).toBeUndefined();
  });

  it("escapes single quotes in WIQL", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ workItems: [] }));
    await new AdoPatClient(cfg).searchWorkItems({ text: "user's incident" });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.query).toContain("CONTAINS 'user''s incident'");
  });

  it("returns [] without fetching details when WIQL matches nothing", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ workItems: [] }));
    const items = await new AdoPatClient(cfg).searchWorkItems({ text: "nope" });
    expect(items).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns [] when integration is disabled, without any fetch", async () => {
    const items = await new AdoPatClient({ ...cfg, enabled: false }).searchWorkItems({ text: "x" });
    expect(items).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("createBug posts json-patch document", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 99, fields: { "System.Title": "[INC0001] DB down" } }));
    const created = await new AdoPatClient(cfg).createBug({
      title: "[INC0001] DB down",
      description: "line1\nline2",
      areaPath: "Platform\\SRE",
      iterationPath: "Platform\\Sprint 1",
      tags: ["ServiceNow", "Incident"],
      incidentNumber: "INC0001"
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://dev.azure.com/acme/Platform/_apis/wit/workitems/$Bug?api-version=7.1");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json-patch+json");
    const ops = JSON.parse(init.body as string) as Array<{ op: string; path: string; value: string }>;
    expect(ops).toContainEqual({ op: "add", path: "/fields/System.Title", value: "[INC0001] DB down" });
    expect(ops).toContainEqual({ op: "add", path: "/fields/Microsoft.VSTS.TCM.ReproSteps", value: "line1<br>line2" });
    expect(ops).toContainEqual({ op: "add", path: "/fields/System.AreaPath", value: "Platform\\SRE" });
    expect(ops).toContainEqual({ op: "add", path: "/fields/System.Tags", value: "ServiceNow; Incident" });
    expect(created).toEqual({ id: 99, title: "[INC0001] DB down" });
  });

  it("maps a 1-4 priority to Microsoft.VSTS.Common.Priority and omits out-of-range", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 1, fields: { "System.Title": "t" } }));
    await new AdoPatClient(cfg).createBug({ title: "t", description: "d", priority: "1", incidentNumber: "INC1" });
    let ops = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(ops).toContainEqual({ op: "add", path: "/fields/Microsoft.VSTS.Common.Priority", value: 1 });

    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 2, fields: { "System.Title": "t" } }));
    await new AdoPatClient(cfg).createBug({ title: "t", description: "d", priority: "9", incidentNumber: "INC2" });
    ops = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(ops.some((o: { path: string }) => o.path === "/fields/Microsoft.VSTS.Common.Priority")).toBe(false);
  });

  it("createBug throws when integration is disabled", async () => {
    await expect(
      new AdoPatClient({ ...cfg, enabled: false }).createBug({ title: "t", description: "d", incidentNumber: "INC1" })
    ).rejects.toThrow(/disabled/);
  });

  it("percent-encodes the project path segment", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ workItems: [] }));
    await new AdoPatClient({ ...cfg, project: "My Project" }).searchWorkItems({ text: "x" });
    expect(fetchMock.mock.calls[0][0] as string).toContain("/My%20Project/_apis/");
  });

  it("throws when enabled but orgUrl/project missing", async () => {
    const broken = { ...cfg, orgUrl: undefined, project: undefined };
    await expect(new AdoPatClient(broken).searchWorkItems({ text: "x" })).rejects.toThrow(/not configured/);
    await expect(new AdoPatClient(broken).createBug({ title: "t", description: "d", incidentNumber: "I" }))
      .rejects.toThrow(/not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes a proxy dispatcher to fetch when proxyUrl is set", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ workItems: [] }));
    await new AdoPatClient({ ...cfg, proxyUrl: "http://proxy.example:8080" }).searchWorkItems({ text: "x" });
    expect((fetchMock.mock.calls[0][1] as { dispatcher?: unknown }).dispatcher).toBeDefined();

    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(jsonResponse({ workItems: [] }));
    await new AdoPatClient(cfg).searchWorkItems({ text: "x" });
    expect((fetchMock.mock.calls[0][1] as { dispatcher?: unknown }).dispatcher).toBeUndefined();
  });

  it("throws with status and body snippet on non-2xx", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false, status: 403, json: async () => ({}), text: async () => "TF401027 denied"
    } as unknown as Response);
    await expect(new AdoPatClient(cfg).searchWorkItems({ text: "x" })).rejects.toThrow(/403.*TF401027/);
  });

  it("createWorkItem posts json-patch for a User Story with parent-less fields", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 500, fields: { "System.Title": "Add SSO" } }));
    const wi = await new AdoPatClient(cfg).createWorkItem({
      type: "User Story",
      title: "Add SSO",
      description: "line1\nline2",
      areaPath: "Platform\\Alpha",
      tags: ["auth"],
      assignedTo: "jane@x.com",
      priority: "2",
      storyPoints: 5
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://dev.azure.com/acme/Platform/_apis/wit/workitems/$User%20Story?api-version=7.1");
    const ops = JSON.parse(init.body as string) as Array<{ op: string; path: string; value: string | number }>;
    expect(ops).toContainEqual({ op: "add", path: "/fields/System.Title", value: "Add SSO" });
    expect(ops).toContainEqual({ op: "add", path: "/fields/System.Description", value: "line1<br>line2" });
    expect(ops).toContainEqual({ op: "add", path: "/fields/System.AreaPath", value: "Platform\\Alpha" });
    expect(ops).toContainEqual({ op: "add", path: "/fields/System.Tags", value: "auth" });
    expect(ops).toContainEqual({ op: "add", path: "/fields/System.AssignedTo", value: "jane@x.com" });
    expect(ops).toContainEqual({ op: "add", path: "/fields/Microsoft.VSTS.Common.Priority", value: 2 });
    expect(ops).toContainEqual({ op: "add", path: "/fields/Microsoft.VSTS.Scheduling.StoryPoints", value: 5 });
    expect(wi).toMatchObject({ id: 500, title: "Add SSO" });
  });

  it("createWorkItem routes a Bug description to ReproSteps", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 1, fields: { "System.Title": "b" } }));
    await new AdoPatClient(cfg).createWorkItem({ type: "Bug", title: "b", description: "x\ny" });
    const ops = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(ops).toContainEqual({ op: "add", path: "/fields/Microsoft.VSTS.TCM.ReproSteps", value: "x<br>y" });
    expect(ops.some((o: { path: string }) => o.path === "/fields/System.Description")).toBe(false);
  });

  it("getWorkItemFields returns the raw fields map", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 5, fields: { "System.Title": "S", "System.WorkItemType": "User Story" } }));
    const f = await new AdoPatClient(cfg).getWorkItemFields(5);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toBe("https://dev.azure.com/acme/Platform/_apis/wit/workitems/5?$expand=fields&api-version=7.1");
    expect(f).toEqual({ "System.Title": "S", "System.WorkItemType": "User Story" });
  });

  it("listChildren queries WIQL by parent and returns ids", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ workItems: [{ id: 11 }, { id: 12 }] }));
    const ids = await new AdoPatClient(cfg).listChildren(9);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.query).toBe("SELECT [System.Id] FROM WorkItems WHERE [System.Parent] = 9 ORDER BY [System.Id]");
    expect(ids).toEqual([11, 12]);
  });

  it("addRelation patches a Hierarchy-Reverse link for a parent", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 3 }));
    await new AdoPatClient(cfg).addRelation(3, 2, "parent");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://dev.azure.com/acme/Platform/_apis/wit/workitems/3?api-version=7.1");
    expect(init.method).toBe("PATCH");
    const ops = JSON.parse(init.body as string);
    expect(ops[0]).toEqual({
      op: "add",
      path: "/relations/-",
      value: { rel: "System.LinkTypes.Hierarchy-Reverse", url: "https://dev.azure.com/acme/_apis/wit/workitems/2" }
    });
  });

  it("addRelation uses System.LinkTypes.Related for a related link", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 3 }));
    await new AdoPatClient(cfg).addRelation(3, 8, "related");
    const ops = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(ops[0].value.rel).toBe("System.LinkTypes.Related");
  });

  it("addRelation rejects a non-integer id without fetching", async () => {
    await expect(new AdoPatClient(cfg).addRelation(1.5, 2, "parent")).rejects.toThrow(/integer/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
