import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import type { PageDoc } from "../../services/knowledge/types.js";

/** Resolve an href against base; return undefined unless it's http(s). */
const absolutize = (href: string, base: string): string | undefined => {
  try {
    const u = new URL(href, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    u.hash = "";
    return u.toString();
  } catch {
    return undefined;
  }
};

/**
 * Parse HTML into clean main text + resolved outbound links.
 * Readability gives the salient article text; we still harvest links from the
 * full DOM (Readability strips most nav links we'd want as crawl frontier).
 */
export const extractPage = (html: string, baseUrl: string): PageDoc => {
  const { document } = parseHTML(html);

  const links = [
    ...new Set(
      [...document.querySelectorAll("a[href]")]
        .map((a) => absolutize(a.getAttribute("href") ?? "", baseUrl))
        .filter((l): l is string => !!l)
    )
  ];

  let title = document.querySelector("title")?.textContent?.trim() || undefined;
  let mainText = "";
  try {
    const parsed = new Readability(document as any).parse();
    if (parsed) {
      title = parsed.title?.trim() || title;
      mainText = (parsed.textContent ?? "")
        .replace(/\s+\n/g, "\n")
        .replace(/[ \t]{2,}/g, " ")
        .trim();
    }
  } catch {
    // Readability can throw on malformed DOM; fall back to body text.
  }
  if (!mainText) mainText = (document.body?.textContent ?? "").replace(/\s{2,}/g, " ").trim();

  return { title, mainText, links };
};
