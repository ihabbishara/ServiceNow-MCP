import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpRuntime } from "../runtime.js";
import { ChangeRecord } from "../types.js";

const formatChangeAsMarkdown = (change: ChangeRecord): string => {
  const schedule = [
    change.plannedStartDate ? `- **Planned Start:** ${change.plannedStartDate}` : null,
    change.plannedEndDate ? `- **Planned End:** ${change.plannedEndDate}` : null,
    change.actualStartDate ? `- **Actual Start:** ${change.actualStartDate}` : null,
    change.actualEndDate ? `- **Actual End:** ${change.actualEndDate}` : null
  ]
    .filter(Boolean)
    .join("\n");

  return `# Change ${change.number}

## Overview
- **State:** ${change.state}
- **Type:** ${change.type ?? "N/A"}
- **Risk:** ${change.risk ?? "N/A"}
- **Impact:** ${change.impact ?? "N/A"}
- **Assignment Group:** ${change.assignmentGroup ?? "N/A"}
- **Assigned To:** ${change.assignedTo ?? "Unassigned"}
- **Business Service:** ${change.businessService ?? "N/A"}
- **Configuration Item:** ${change.cmdbCi ?? "N/A"}

## Description
${change.shortDescription}

${change.description ?? ""}

## Schedule
${schedule || "_No schedule information_"}

## Implementation Plan
${change.implementationPlan ?? "_No implementation plan provided_"}

## Backout Plan
${change.backoutPlan ?? "_No backout plan provided_"}

## Test Plan
${change.testPlan ?? "_No test plan provided_"}

## Close Information
${change.closeCode ? `- **Close Code:** ${change.closeCode}` : ""}
${change.closeNotes ? `- **Close Notes:** ${change.closeNotes}` : ""}
`;
};

export const registerChangeResources = (server: McpServer, runtime: McpRuntime): void => {
  // Resource template for change://CHG*
  server.resource(
    "change",
    "change://{number}",
    async (uri) => {
      const number = uri.pathname.replace("//", "");
      const change = await runtime.serviceNowClient.getChangeByNumber(number);

      if (!change) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "text/plain",
              text: `Change ${number} not found`
            }
          ]
        };
      }

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/markdown",
            text: formatChangeAsMarkdown(change)
          }
        ]
      };
    }
  );
};
