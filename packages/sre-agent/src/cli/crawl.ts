import type { McpRuntime } from "@sre/core";

/**
 * Fire-and-forget crawl at app boot. Two-tier gate:
 *  • Index stale (older than `ttlHours`, or never crawled) → full crawl of all seeds.
 *  • Index fresh but a seed has never been indexed (e.g. just added to CRAWL_SEEDS)
 *    → crawl ONLY the missing seed(s), so the TTL doesn't hide it. lastCrawl is a
 *    global MAX(crawled_at), blind to per-seed gaps, so freshness alone isn't enough.
 *  • Otherwise → skip.
 * Unchanged pages are content-hash deduped inside crawl(); this gate only avoids
 * running it at all (network round-trips + byok per-page verdict spend).
 * Non-blocking: returns immediately; any crawl runs in the background.
 */
export const bootCrawl = (
  runtime: McpRuntime,
  opts: { enabled: boolean; ttlHours: number },
  log: (m: string) => void = (m) => process.stderr.write(m + "\n")
): void => {
  if (!opts.enabled) return;
  void (async () => {
    try {
      const { lastCrawl } = await runtime.knowledge.stats();
      const ttlMs = opts.ttlHours * 3_600_000;
      const fresh = !!lastCrawl && ttlMs > 0 && Date.now() - lastCrawl < ttlMs;

      if (!fresh) {
        log("[crawl] starting background boot crawl (all seeds)…");
        const res = await runtime.knowledge.crawl({}, log);
        log(`[crawl] boot crawl complete: ${JSON.stringify(res)}`);
        return;
      }

      // Fresh by TTL — but still pick up any seed that was never indexed.
      const missing = await runtime.knowledge.unindexedSeeds();
      if (missing.length === 0) {
        log(`[crawl] index fresh (last crawl ${new Date(lastCrawl!).toISOString()}); skipping boot crawl`);
        return;
      }
      log(`[crawl] index fresh but ${missing.length} seed(s) not yet indexed; crawling those…`);
      const res = await runtime.knowledge.crawl({ seeds: missing }, log);
      log(`[crawl] new-seed crawl complete: ${JSON.stringify(res)}`);
    } catch (err) {
      log(`[crawl] boot crawl failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  })();
};

/** Parse `--seed <url>` (repeatable) and `--status` from argv slice. */
const parseArgs = (argv: string[]) => {
  const seeds: string[] = [];
  let status = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--seed" && argv[i + 1]) seeds.push(argv[++i]);
    else if (argv[i] === "--status") status = true;
  }
  return { seeds, status };
};

/**
 * `sre-agent crawl [--seed <url>]... [--status]`
 * Returns a process exit code. Network/LLM work is delegated to the runtime's
 * KnowledgeService so this stays unit-testable with a fake runtime.
 */
export const runCrawl = async (
  runtime: McpRuntime,
  argv: string[],
  log: (m: string) => void = (m) => process.stderr.write(m + "\n")
): Promise<number> => {
  const { seeds, status } = parseArgs(argv);
  try {
    if (status) {
      log(`[crawl] index stats: ${JSON.stringify(await runtime.knowledge.stats())}`);
      return 0;
    }
    const overrides = seeds.length > 0 ? { seeds } : {};
    const res = await runtime.knowledge.crawl(overrides, log);
    log(`[crawl] complete: ${JSON.stringify(res)}`);
    log(`[crawl] index stats: ${JSON.stringify(await runtime.knowledge.stats())}`);
    return 0;
  } catch (err) {
    log(`[crawl] failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    await runtime.knowledge.close?.();
  }
};
