import type { CrawlVerdict } from "./types.js";

/**
 * Build the single combined relevance + link-keep prompt. Keeping it one call
 * per page halves crawl LLM cost vs separate relevance/link calls.
 */
export const buildVerdictPrompt = (
  topic: string | undefined,
  title: string | undefined,
  bodyHead: string,
  links: string[],
  maxLinks: number
): string => {
  const scope = topic
    ? `The crawl topic is: "${topic}".`
    : "The goal is to collect useful internal documentation.";
  const linkList = links
    .slice(0, maxLinks)
    .map((l, i) => `${i + 1}. ${l}`)
    .join("\n");
  return [
    `${scope}`,
    `Decide (1) whether THIS page is worth indexing, and (2) which of its links are worth following.`,
    ``,
    `PAGE TITLE: ${title ?? "(none)"}`,
    `PAGE TEXT (truncated):`,
    bodyHead,
    ``,
    `LINKS:`,
    linkList || "(none)",
    ``,
    `Respond with STRICT JSON only, no prose:`,
    `{"relevant": <true|false>, "keepLinks": [<urls to follow, copied verbatim from LINKS>]}`
  ].join("\n");
};

/** Parse the model's JSON verdict; fail-soft to keep-but-no-links. */
export const parseVerdict = (raw: string): CrawlVerdict => {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const obj = JSON.parse(raw.slice(start, end + 1));
      return {
        relevant: typeof obj.relevant === "boolean" ? obj.relevant : true,
        keepLinks: Array.isArray(obj.keepLinks)
          ? obj.keepLinks.filter((x: unknown) => typeof x === "string")
          : []
      };
    } catch {
      /* fall through */
    }
  }
  return { relevant: true, keepLinks: [] };
};
