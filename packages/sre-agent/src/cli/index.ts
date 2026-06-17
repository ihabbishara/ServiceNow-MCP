import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { defineTool } from "@github/copilot-sdk";
import { z } from "zod";
import { createMcpRuntime } from "@sre/core";
import { loadAgentConfig } from "../config.js";
import { ChatEngine } from "../engine/engine.js";

const main = async () => {
  // Fail fast on bad/missing agent config before touching the SDK or runtime.
  const config = loadAgentConfig();
  const runtime = createMcpRuntime(); // reuses core config from process.env

  const getIncident = defineTool("get_incident", {
    description:
      "Get complete details of a specific ServiceNow incident by number (e.g., INC0012345)",
    parameters: z.object({
      number: z.string().describe("Incident number, e.g. INC0012345")
    }),
    skipPermission: true,
    handler: async ({ number }: { number: string }) => {
      const inc = await runtime.serviceNowClient.getIncidentByNumber(number);
      return inc ?? { error: `Incident ${number} not found` };
    }
  });

  const engine = new ChatEngine({
    config,
    tools: [getIncident],
    confirm: async () => true,
    onDelta: (t) => stdout.write(t),
    onToolStart: (n) => stdout.write(`\n  ↳ ${n}…\n`)
  });

  await engine.start();
  stdout.write(
    "SRE agent ready. Ask about incidents. Ctrl-C aborts the current turn; press it again (or type /exit) to quit.\n"
  );

  const rl = readline.createInterface({ input: stdin, output: stdout });

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
