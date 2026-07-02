import { ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * Wraps a resource read handler so a thrown error becomes a readable error
 * payload instead of an opaque MCP internal-error (-32603). Mirrors the
 * try/catch → isError convention the tool handlers use.
 */
export const safeResource = <A extends unknown[]>(
  handler: (uri: URL, ...args: A) => Promise<ReadResourceResult>
): ((uri: URL, ...args: A) => Promise<ReadResourceResult>) => {
  return async (uri, ...args) => {
    try {
      return await handler(uri, ...args);
    } catch (error) {
      return {
        contents: [
          { uri: uri.href, mimeType: "text/plain", text: `Error reading resource: ${error}` }
        ]
      };
    }
  };
};
