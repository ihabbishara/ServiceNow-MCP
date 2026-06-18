// Standalone Copilot seat-auth probe. Independent of the agent's dist build:
// it constructs the SAME default CopilotClient the engine uses (no options →
// pure auto-detect) and reports what credential the bundled runtime resolved.
//
// Run from the repo root. To mirror the agent's exact environment, pass the
// same --env-file the agent uses:
//
//   node --env-file=packages/sre-agent/.env packages/sre-agent/scripts/auth-probe.mjs
//
// Reads (does not require) COPILOT_GITHUB_TOKEN / COPILOT_HOME so you can A/B a
// fix in one line, e.g.:
//   $env:COPILOT_GITHUB_TOKEN = (gh auth token); node packages/sre-agent/scripts/auth-probe.mjs
import { CopilotClient } from "@github/copilot-sdk";

const redact = (t) => (t ? `${t.slice(0, 4)}… (len ${t.length})` : "<unset>");

console.error("[probe] ambient credential env:");
for (const name of ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]) {
  console.error(`  ${name} = ${redact(process.env[name])}`);
}
console.error(`  COPILOT_HOME = ${process.env.COPILOT_HOME ?? "<unset> (default ~/.copilot)"}`);

// Mirror the engine's seat-auth wiring: pass gitHubToken / baseDirectory only if
// set, otherwise pure auto-detect (the failing default).
const options = {};
if (process.env.COPILOT_GITHUB_TOKEN) options.gitHubToken = process.env.COPILOT_GITHUB_TOKEN;
if (process.env.COPILOT_HOME) options.baseDirectory = process.env.COPILOT_HOME;

const client = new CopilotClient(options);
try {
  await client.start();
  const status = await client.getAuthStatus();
  console.error("[probe] AUTH " + JSON.stringify(status));
  try {
    const models = await client.listModels();
    console.error("[probe] MODELS(" + models.length + ") " + models.map((m) => m.id).join(","));
  } catch (e) {
    console.error("[probe] MODELS_FAIL " + (e?.message ?? String(e)));
  }
} catch (e) {
  console.error("[probe] START_FAIL " + (e?.message ?? String(e)));
} finally {
  await client.stop().catch(() => {});
  process.exit(0);
}
