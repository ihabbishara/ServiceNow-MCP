import { z } from "zod";
import { defineSpec } from "../spec.js";

export const knowledgeSpecs = [
  defineSpec({
    name: "search_knowledge",
    description:
      "Search the internal documentation knowledge index (runbooks, wikis, KB) by meaning. Use to find a procedure, fix, or reference relevant to an incident. Returns ranked snippets with source URLs to cite.",
    schema: {
      query: z.string().describe("Natural-language search query"),
      k: z.number().optional().describe("Number of results (default 6, max 20)"),
      domain: z.string().optional().describe("Restrict to a single host, e.g. wiki.acme.io")
    },
    run: async (rt, a) => rt.knowledge.search(a.query, a.k, a.domain)
  }),

  defineSpec({
    name: "index_url",
    description:
      "Crawl and index a small set of internal pages starting from a URL into the knowledge index, then they become searchable via search_knowledge. Bounded (shallow, few pages) for use mid-conversation; use the `sre-agent crawl` CLI for full site ingest.",
    schema: {
      url: z.string().describe("Seed URL to crawl from (must be within an allowed domain)"),
      depth: z.number().optional().describe("Link-follow depth, clamped to 2"),
      max_pages: z.number().optional().describe("Max pages, clamped to 25")
    },
    run: async (rt, a) => {
      const res = await rt.knowledge.crawl(
        {
          seeds: [a.url],
          maxDepth: Math.min(a.depth ?? 1, 2),
          maxPages: Math.min(a.max_pages ?? 10, 25)
        },
        () => {}
      );
      return {
        pages_crawled: res.pagesCrawled,
        chunks_added: res.chunksAdded,
        skipped: res.pagesSkipped
      };
    }
  })
];
