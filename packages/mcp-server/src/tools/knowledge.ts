import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { McpRuntime } from "@sre/core";

const asText = (obj: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }]
});
const asError = (err: unknown) => ({
  content: [{ type: "text" as const, text: `Error: ${String(err)}` }],
  isError: true
});

export const registerKnowledgeTools = (server: McpServer, runtime: McpRuntime): void => {
  server.tool(
    "search_knowledge",
    "Search the internal documentation knowledge index by meaning; returns ranked snippets with source URLs.",
    {
      query: z.string().describe("Natural-language search query"),
      k: z.number().optional().describe("Number of results (default 6, max 20)"),
      domain: z.string().optional().describe("Restrict to a single host, e.g. wiki.acme.io")
    },
    async (args) => {
      try {
        return asText(await runtime.knowledge.search(args.query, args.k, args.domain));
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.tool(
    "index_url",
    "Crawl and index a bounded set of internal pages from a seed URL into the knowledge index.",
    {
      url: z.string().describe("Seed URL (within an allowed domain)"),
      depth: z.number().optional().describe("Link-follow depth, clamped to 2"),
      max_pages: z.number().optional().describe("Max pages, clamped to 25")
    },
    async (args) => {
      try {
        const res = await runtime.knowledge.crawl(
          {
            seeds: [args.url],
            maxDepth: Math.min(args.depth ?? 1, 2),
            maxPages: Math.min(args.max_pages ?? 10, 25)
          },
          () => {}
        );
        return asText({
          pages_crawled: res.pagesCrawled,
          chunks_added: res.chunksAdded,
          skipped: res.pagesSkipped
        });
      } catch (error) {
        return asError(error);
      }
    }
  );
};
