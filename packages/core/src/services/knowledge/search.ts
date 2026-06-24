import type { LlmClient, SearchHit } from "./types.js";
import type { KnowledgeStore } from "./store.js";

export interface SearchResponse {
  count: number;
  results: SearchHit[];
  hint?: string;
}

export const search = async (
  deps: { llm: Pick<LlmClient, "embed">; store: Pick<KnowledgeStore, "knn"> },
  query: string,
  k = 6,
  domain?: string
): Promise<SearchResponse> => {
  const vec = await deps.llm.embed(query);
  const results = deps.store.knn(vec, Math.min(Math.max(k, 1), 20), domain);
  return {
    count: results.length,
    // Drop the full chunk `text` the store returns; tool output exposes only the snippet.
    results: results.map(({ text, ...hit }) => hit),
    hint: results.length === 0 ? "index empty or no match — run `sre-agent crawl` to populate it" : undefined
  };
};
