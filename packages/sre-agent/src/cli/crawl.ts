import type { McpRuntime } from "@sre/core";

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
