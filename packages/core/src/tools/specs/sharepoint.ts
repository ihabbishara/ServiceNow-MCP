import { z } from "zod";
import { ToolError, defineSpec } from "../spec.js";

const DISABLED_MSG = "SharePoint integration is disabled (set SHAREPOINT_ENABLED=true).";

export const sharePointSpecs = [
  defineSpec({
    name: "get_incident_documents",
    description:
      "Fetch an incident's supporting documents from SharePoint by incident number (e.g. INC123456). " +
      "Recursively reads the incident folder's Docs subtree (docx/xlsx/pptx/pdf) and returns extracted " +
      "text to read and cite. Use when the user references an incident and asks about its docs, runbook, " +
      "postmortem, or details that live in SharePoint rather than ServiceNow.",
    schema: {
      incident: z.string().describe("Incident number, e.g. INC123456")
    },
    enabledWhen: (c) => (c.sharePoint.enabled ? null : DISABLED_MSG),
    run: async (rt, a) => {
      // Defense in depth: enabledWhen gates on config, this guards a runtime without the service.
      if (!rt.sharePoint) throw new ToolError(DISABLED_MSG);
      return rt.sharePoint.getIncidentDocuments(a.incident);
    }
  })
];
