/**
 * Live repro for the `sendAndWait` turn-timeout bug.
 *
 * Mirrors the production wiring (loadDotenv → loadAgentConfig → createMcpRuntime →
 * buildTools → ChatEngine) and runs ONE real turn against your Copilot seat +
 * ServiceNow, timing it against the configured deadline.
 *
 * Reproduce the bug (force the old SDK 60s default):
 *   TURN_TIMEOUT_MS=60000 npx tsx packages/sre-agent/scripts/repro-turn-timeout.ts
 *   → expect: ❌ "Timeout after 60000ms waiting for session.idle" at ~60s
 *
 * Prove the fix (5-min default, or whatever your .env sets):
 *   npx tsx packages/sre-agent/scripts/repro-turn-timeout.ts
 *   → expect: ✅ turn completes, elapsed printed
 *
 * Smoke-test the harness itself without a seat (no network turn):
 *   REPRO_DRY=1 npx tsx packages/sre-agent/scripts/repro-turn-timeout.ts
 *
 * Optional: pass a custom prompt as args. Default: "Provide me the latest 5 incidents".
 *
 * Exit codes: 0 turn completed · 1 hit the timeout · 2 not authenticated · 3 fatal.
 */
import { createMcpRuntime } from "@sre/core";
import { ChatEngine, loadAgentConfig, loadDotenv, buildTools } from "../dist/index.js";

const PROMPT = process.argv.slice(2).join(" ").trim() || "Provide me the latest 5 incidents";
const DRY = process.env.REPRO_DRY === "1";

const closeRuntime = async (runtime: { knowledge?: { close?: () => Promise<unknown> } }) => {
  await runtime.knowledge?.close?.().catch(() => {});
};

const main = async () => {
  loadDotenv();
  const config = loadAgentConfig();
  const runtime = createMcpRuntime();

  console.error(
    `[repro] turnTimeoutMs=${config.turnTimeoutMs}  model=${config.llm.model}  ` +
      `mode=${config.llm.mode}  tools=${buildTools(runtime).length}`
  );
  console.error(`[repro] prompt: ${PROMPT}`);

  if (DRY) {
    console.error("[repro] REPRO_DRY=1 → wiring OK, skipping the live turn.");
    await closeRuntime(runtime);
    process.exit(0);
  }

  const engine = new ChatEngine({
    config,
    tools: buildTools(runtime),
    confirm: async () => false, // never approve a write during a repro
    onDelta: (t) => process.stdout.write(t),
    onToolStart: (n) => process.stderr.write(`\n  ↳ ${n}…\n`)
  });

  await engine.start();

  if (config.llm.mode === "seat") {
    const status = await engine.getAuthStatus();
    if (!status.isAuthenticated) {
      console.error(
        "[repro] Copilot not authenticated — run `sre-agent` once and /login, then retry."
      );
      await engine.stop();
      await closeRuntime(runtime);
      process.exit(2);
    }
  }

  const t0 = Date.now();
  try {
    await engine.send(PROMPT);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.error(`\n[repro] ✅ turn completed in ${secs}s (deadline ${config.turnTimeoutMs}ms)`);
    await engine.stop();
    await closeRuntime(runtime);
    process.exit(0);
  } catch (e) {
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const msg = e instanceof Error ? e.message : String(e);
    const isTimeout = /Timeout after \d+ms waiting for session\.idle/.test(msg);
    console.error(`\n[repro] ❌ turn failed after ${secs}s: ${msg}`);
    if (isTimeout) {
      console.error(
        "[repro] ^ This IS the bug: the wait deadline fired while the turn was still running.\n" +
          "[repro]   Raise TURN_TIMEOUT_MS (the fix) and re-run — same turn should complete."
      );
    }
    await engine.stop();
    await closeRuntime(runtime);
    process.exit(1);
  }
};

main().catch((e) => {
  console.error("[repro] fatal:", e instanceof Error ? (e.stack ?? e.message) : e);
  process.exit(3);
});
