import { isAllowed } from "./robots.js";

/**
 * Fetches and caches robots.txt per host, then evaluates a URL's path.
 * When CRAWL_RESPECT_ROBOTS is false the caller should not use this at all.
 *
 * Depends only on `getText` (robots.txt is text/plain, which `Fetcher.get`
 * would reject as non-html) so a real `Fetcher` satisfies it and tests can fake it.
 */
export class RobotsClient {
  private readonly cache = new Map<string, string>();
  constructor(
    private readonly fetcher: { getText(url: string): Promise<string> },
    private readonly enabled: boolean
  ) {}

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
      const txt = await this.fetcher.getText(`${origin}/robots.txt`);
      this.cache.set(origin, txt);
    }
    return isAllowed(this.cache.get(origin) ?? "", path);
  }
}
