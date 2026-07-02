import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerIncidentResources, registerTeamResources } from "../../src/resources/incidents.js";
import { registerChangeResources } from "../../src/resources/changes.js";
import { registerDashboardResources } from "../../src/resources/dashboards.js";
import { McpRuntime, Incident, ChangeRecord } from "@sre/core";

const incident: Incident = {
  number: "INC0012345",
  sysId: "x",
  priority: "1",
  state: "In Progress",
  shortDescription: "DB down",
  openedAt: "2026-06-11T10:00:00Z",
  updatedAt: "2026-06-11T11:00:00Z"
};
const change: ChangeRecord = {
  number: "CHG0005432",
  sysId: "c",
  state: "Implement",
  shortDescription: "DB patch"
};

const makeRuntime = () => {
  const listIncidents = vi.fn().mockResolvedValue([incident]);
  const runtime = {
    serviceNowClient: {
      getIncidentByNumber: vi.fn().mockResolvedValue(incident),
      getChangeByNumber: vi.fn().mockResolvedValue(change),
      listIncidents
    },
    incidentService: {
      listSlaRisks: vi.fn().mockResolvedValue([]),
      listStaleIncidents: vi.fn().mockResolvedValue([])
    },
    slaRiskService: { assess: vi.fn().mockReturnValue([]) },
    staleTicketService: { findStale: vi.fn().mockReturnValue([]) }
  } as unknown as McpRuntime;
  return { runtime, listIncidents };
};

const connect = async (runtime: McpRuntime) => {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerIncidentResources(server, runtime);
  registerTeamResources(server, runtime);
  registerChangeResources(server, runtime);
  registerDashboardResources(server, runtime);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
};

describe("MCP resource surface", () => {
  let client: Client;
  let listIncidents: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const made = makeRuntime();
    listIncidents = made.listIncidents;
    client = await connect(made.runtime);
  });

  it("advertises the three parameterized resources as templates", async () => {
    const { resourceTemplates } = await client.listResourceTemplates();
    const uris = resourceTemplates.map((t) => t.uriTemplate).sort();
    expect(uris).toEqual(["change://{number}", "incident://{number}", "team://{name}/incidents"]);
  });

  it("resolves incident://{number} to the real incident markdown", async () => {
    const res = await client.readResource({ uri: "incident://INC0012345" });
    expect(res.contents[0].mimeType).toBe("text/markdown");
    expect(res.contents[0].text).toContain("Incident INC0012345");
    expect(res.contents[0].text).toContain("DB down");
  });

  it("resolves change://{number} to the real change markdown", async () => {
    const res = await client.readResource({ uri: "change://CHG0005432" });
    expect(res.contents[0].text).toContain("Change CHG0005432");
  });

  it("passes the decoded team name (with spaces) to the query and fetches incidents once", async () => {
    const res = await client.readResource({ uri: "team://Platform%20SRE/incidents" });
    expect(listIncidents).toHaveBeenCalledTimes(1);
    expect(listIncidents).toHaveBeenCalledWith(
      expect.objectContaining({ assignmentGroup: "Platform SRE" })
    );
    expect(res.contents[0].text).toContain("Platform SRE Team");
  });

  it("still serves the static dashboard resources", async () => {
    const res = await client.readResource({ uri: "sla-dashboard://current" });
    expect(res.contents[0].text).toContain("SLA Risk Dashboard");
  });

  it("returns a graceful error instead of rejecting when the backend throws", async () => {
    const made = makeRuntime();
    (
      made.runtime.serviceNowClient.getIncidentByNumber as ReturnType<typeof vi.fn>
    ).mockRejectedValue(new Error("ServiceNow 503"));
    const c = await connect(made.runtime);
    const res = await c.readResource({ uri: "incident://INC0000001" });
    expect(res.contents[0].text).toMatch(/Error.*503/);
  });
});
