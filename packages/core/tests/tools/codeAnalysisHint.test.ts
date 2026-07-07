import { describe, it, expect, vi } from "vitest";
import { TOOL_SPECS } from "../../src/tools/registry.js";
import type { McpRuntime } from "../../src/runtime.js";

const spec = (n: string) => TOOL_SPECS.find((s) => s.name === n)!;

const INCIDENT = {
  number: "INC0012345",
  priority: "1",
  state: "In Progress",
  shortDescription: "Checkout failing",
  description: "TypeError: Cannot read properties of undefined at charge (charge.ts:42:11)",
  assignedTo: "Jane",
  assignmentGroup: "Payments",
  businessService: "Checkout",
  cmdbCi: "pay-svc",
  openedAt: "2026-07-07T08:00:00Z",
  updatedAt: "2026-07-07T09:00:00Z",
  slaDue: null,
  workNotes: ["restarted pod, no effect"],
  comments: []
};

const makeRuntime = (orgUrl?: string, incident: object = INCIDENT) =>
  ({
    config: { azureDevOps: { orgUrl } },
    serviceNowClient: { getIncidentByNumber: vi.fn(async () => incident) },
    incidentService: {
      summarizeIncident: vi.fn(async () => ({
        incident: INCIDENT,
        relatedChanges: [],
        relatedWorkItems: []
      }))
    }
  }) as unknown as McpRuntime;

describe("codeAnalysis hint", () => {
  it("get_incident appends the hint when ADO configured and signals present", async () => {
    const res = (await spec("get_incident").run(makeRuntime("https://dev.azure.com/Org"), {
      number: "INC0012345"
    })) as Record<string, unknown>;
    const hint = res.codeAnalysis as {
      signalsDetected: boolean;
      signals: string[];
      nextStep: string;
    };
    expect(hint.signalsDetected).toBe(true);
    expect(hint.signals[0]).toContain("charge.ts:42");
    expect(hint.nextStep).toContain("ask the user");
    expect(hint.nextStep).toContain("_git/");
    expect(res.number).toBe("INC0012345"); // original fields preserved
  });

  it("summarize_incident appends the hint at top level", async () => {
    const res = (await spec("summarize_incident").run(makeRuntime("https://dev.azure.com/Org"), {
      number: "INC0012345"
    })) as Record<string, unknown>;
    expect(res.codeAnalysis).toMatchObject({ signalsDetected: true });
    expect(res.incident).toBeDefined();
  });

  it("omits the hint when ADO is not configured", async () => {
    const res = (await spec("get_incident").run(makeRuntime(undefined), {
      number: "INC0012345"
    })) as Record<string, unknown>;
    expect("codeAnalysis" in res).toBe(false);
  });

  it("omits the hint when the incident text is clean", async () => {
    const clean = { ...INCIDENT, description: "users report slowness", workNotes: [] };
    const rt = makeRuntime("https://dev.azure.com/Org", clean);
    (rt.incidentService.summarizeIncident as ReturnType<typeof vi.fn>).mockResolvedValue({
      incident: clean,
      relatedChanges: [],
      relatedWorkItems: []
    });
    const got = (await spec("get_incident").run(rt, { number: "INC0012345" })) as Record<
      string,
      unknown
    >;
    expect("codeAnalysis" in got).toBe(false);
    const sum = (await spec("summarize_incident").run(rt, { number: "INC0012345" })) as Record<
      string,
      unknown
    >;
    expect("codeAnalysis" in sum).toBe(false);
  });

  it("scans workNotes and comments, not just description", async () => {
    const noteOnly = {
      ...INCIDENT,
      description: "see notes",
      workNotes: ["stack: at pay (billing.py:9)"]
    };
    const res = (await spec("get_incident").run(
      makeRuntime("https://dev.azure.com/Org", noteOnly),
      {
        number: "INC0012345"
      }
    )) as Record<string, unknown>;
    expect(res.codeAnalysis).toMatchObject({ signalsDetected: true });
  });
});
