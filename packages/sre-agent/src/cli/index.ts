import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createMcpRuntime } from "@sre/core";
import { loadAgentConfig } from "../config.js";
import { ChatEngine } from "../engine/engine.js";
import { buildTools } from "../tools/index.js";
import { runDoctor } from "../doctor.js";

const main = async () => {
  // Fail fast on bad/missing agent config before touching the SDK, runtime, or az.
  const config = loadAgentConfig();

  // When ADO runs through the Azure CLI, verify the session is logged in before
  // we spin up the SDK — a clear "run az login" beats an opaque tool failure
  // mid-conversation. PAT mode skips this preflight.
  if (config.adoAuthMode === "azcli") {
    await runDoctor(config.raw.AZ_PATH);
  }

  const runtime = createMcpRuntime(); // reuses core config from process.env

  // readline owns the terminal; create it before the engine so the write
  // confirm prompt can reuse the same interface during a tool call.
  const rl = readline.createInterface({ input: stdin, output: stdout });

  const confirm = async (summary: string): Promise<boolean> => {
    // Without an interactive terminal (piped stdin / EOF), rl.question never
    // settles and the turn would hang forever. Decline cleanly instead so the
    // gate rejects and the SDK denies the write.
    if (stdin.isTTY === false) {
      process.stderr.write("[sre-agent] write declined (no interactive terminal)\n");
      return false;
    }
    const ans = (await rl.question(`${summary} [y/N] `)).trim().toLowerCase();
    return ans === "y" || ans === "yes";
  };

  const engine = new ChatEngine({
    config,
    tools: buildTools(runtime),
    confirm,
    onDelta: (t) => stdout.write(t),
    onToolStart: (n) => stdout.write(`\n  ↳ ${n}…\n`)
  });

  await engine.start();
  stdout.write(
    "SRE agent ready. Ask about incidents, changes, SLA risk, or ADO work items. " +
      "Ctrl-C aborts the current turn; press it again (or type /exit) to quit.\n"
  );

  // First Ctrl-C aborts the in-flight turn; a second one within the window
  // (i.e. when nothing is running to abort) quits. This keeps the banner's
  // promise without letting a rejected abort become an unhandled rejection.
  let interrupted = false;
  process.on("SIGINT", () => {
    if (interrupted) {
      stdout.write("\nQuitting.\n");
      process.exit(0);
    }
    interrupted = true;
    stdout.write("\n(aborting current turn — Ctrl-C again to quit)\n");
    engine.abort().catch((e) => {
      console.error("[sre-agent] abort failed:", e instanceof Error ? e.message : e);
    });
  });

  for (;;) {
    const line = (await rl.question("\n> ")).trim();
    if (!line || line === "/exit") break;
    interrupted = false;
    try {
      await engine.send(line);
      stdout.write("\n");
    } catch (e) {
      // A transport failure or sendAndWait timeout must not kill the REPL.
      process.stderr.write(
        `\n[sre-agent] turn failed: ${e instanceof Error ? e.message : String(e)}\n`
      );
      continue;
    }
  }

  await engine.stop();
  rl.close();
};

main().catch((e) => {
  console.error("[sre-agent]", e instanceof Error ? e.message : e);
  process.exit(1);
});
