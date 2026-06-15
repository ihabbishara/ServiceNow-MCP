import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AzureDevOpsClient } from "../../src/clients/ado.js";

const cfg = {
  enabled: true,
  disabledMode: "noop" as const,
  orgUrl: "https://dev.azure.com/acme",
  project: "Platform",
  pat: "pat123",
  defaultAreaPath: "Platform",
  defaultIterationPath: "Platform",
  defaultAssignedTeam: undefined
};

const jsonResponse = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body, text: async () => "" }) as unknown as Response;

describe("AzureDevOpsClient", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

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

    const client = new AzureDevOpsClient(cfg);
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
    await new AzureDevOpsClient(cfg).searchWorkItems({ text: "user's incident" });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.query).toContain("CONTAINS 'user''s incident'");
  });

  it("returns [] without fetching details when WIQL matches nothing", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ workItems: [] }));
    const items = await new AzureDevOpsClient(cfg).searchWorkItems({ text: "nope" });
    expect(items).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns [] when integration is disabled, without any fetch", async () => {
    const items = await new AzureDevOpsClient({ ...cfg, enabled: false }).searchWorkItems({ text: "x" });
    expect(items).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("createBug posts json-patch document", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 99, fields: { "System.Title": "[INC0001] DB down" } }));
    const created = await new AzureDevOpsClient(cfg).createBug({
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
    await new AzureDevOpsClient(cfg).createBug({ title: "t", description: "d", priority: "1", incidentNumber: "INC1" });
    let ops = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(ops).toContainEqual({ op: "add", path: "/fields/Microsoft.VSTS.Common.Priority", value: 1 });

    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 2, fields: { "System.Title": "t" } }));
    await new AzureDevOpsClient(cfg).createBug({ title: "t", description: "d", priority: "9", incidentNumber: "INC2" });
    ops = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(ops.some((o: { path: string }) => o.path === "/fields/Microsoft.VSTS.Common.Priority")).toBe(false);
  });

  it("createBug throws when integration is disabled", async () => {
    await expect(
      new AzureDevOpsClient({ ...cfg, enabled: false }).createBug({ title: "t", description: "d", incidentNumber: "INC1" })
    ).rejects.toThrow(/disabled/);
  });

  it("percent-encodes the project path segment", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ workItems: [] }));
    await new AzureDevOpsClient({ ...cfg, project: "My Project" }).searchWorkItems({ text: "x" });
    expect(fetchMock.mock.calls[0][0] as string).toContain("/My%20Project/_apis/");
  });

  it("throws when enabled but orgUrl/project missing", async () => {
    const broken = { ...cfg, orgUrl: undefined, project: undefined };
    await expect(new AzureDevOpsClient(broken).searchWorkItems({ text: "x" })).rejects.toThrow(/not configured/);
    await expect(new AzureDevOpsClient(broken).createBug({ title: "t", description: "d", incidentNumber: "I" }))
      .rejects.toThrow(/not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws with status and body snippet on non-2xx", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false, status: 403, json: async () => ({}), text: async () => "TF401027 denied"
    } as unknown as Response);
    await expect(new AzureDevOpsClient(cfg).searchWorkItems({ text: "x" })).rejects.toThrow(/403.*TF401027/);
  });
});
