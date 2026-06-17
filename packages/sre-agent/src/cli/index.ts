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
  stdout.write("SRE agent ready. Ask about incidents. Ctrl-C to quit.\n");

  const rl = readline.createInterface({ input: stdin, output: stdout });
  process.on("SIGINT", () => {
    void engine.abort();
  });

  for (;;) {
    const line = (await rl.question("\n> ")).trim();
    if (!line || line === "/exit") break;
    await engine.send(line);
    stdout.write("\n");
  }

  await engine.stop();
  rl.close();
};

main().catch((e) => {
  console.error("[sre-agent]", e instanceof Error ? e.message : e);
  process.exit(1);
});
