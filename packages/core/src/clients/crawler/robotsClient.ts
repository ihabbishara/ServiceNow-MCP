import { Fetcher } from "./fetcher.js";
import { isAllowed } from "./robots.js";

/**
 * Fetches and caches robots.txt per host, then evaluates a URL's path.
 * When CRAWL_RESPECT_ROBOTS is false the caller should not use this at all.
 */
export class RobotsClient {
  private readonly cache = new Map<string, string>();
  constructor(private readonly fetcher: Fetcher, private readonly enabled: boolean) {}

  async fetchAndCheck(url: string): Promise<boolean> {
    if (!this.enabled) return true;
    let origin: string, path: string;
    try {
      const u = new URL(url);
      origin = u.origin;
      path = u.pathname;
    } catch {
      return true;
    }
    if (!this.cache.has(origin)) {
      const res = await this.fetcher.get(`${origin}/robots.txt`);
      // Non-html robots often returns text/plain → fetcher returns ok:false for
      // non-html, so fall back to res.body which is "" → treat as allow-all.
      this.cache.set(origin, res.body ?? "");
    }
    return isAllowed(this.cache.get(origin) ?? "", path);
  }
}
