import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createMcpRuntime } from "@sre/core";
import { loadAgentConfig, type AgentConfig } from "../config.js";
import { ChatEngine } from "../engine/engine.js";
import { copilotLogin, isCopilotAuthError } from "../engine/auth.js";
import { buildTools } from "../tools/index.js";
import { buildWorkflowPrompt } from "../workflows/index.js";
import { runDoctor } from "../doctor.js";

const HELP_TEXT = `Workflow commands:
  /triage <INC>            Triage a ServiceNow incident
  /review <CHG>            Review a change for risks
  /postmortem <INC>        Structure a post-incident review
  /handover <team> [hours] Generate a shift handover (hours default: 8)
  /login                   Re-authenticate to GitHub Copilot (device flow)
  /help                    Show this help
  /exit                    Quit
Anything else is sent to the model as-is.
`;

/**
 * Report the resolved Copilot credential. Crucially, when the runtime resolved
 * an AMBIENT env token (authType="env") and the user did NOT set
 * COPILOT_GITHUB_TOKEN explicitly, this is the exact false-positive that makes
 * turns 403 while auth "looks ok": `isAuthenticated` is true, but the ambient
 * token — not the `copilot login` OAuth — is what gets sent and rejected. Warn
 * loudly in that case instead of a bare "auth ok".
 */
const logCopilotAuthStatus = (
  status: { isAuthenticated: boolean; authType?: string; login?: string },
  config: AgentConfig,
  ctx = ""
): void => {
  const who = status.login ? `, ${status.login}` : "";
  const tail = ctx ? ` ${ctx}` : "";
  if (status.authType === "env" && !config.copilot.githubToken) {
    process.stderr.write(
      `[sre-agent] WARNING: Copilot resolved an ambient env token (authType=env${who})${tail}. ` +
        "If turns fail with a 403, that token — not your `copilot login` — is being used. " +
        "Unset GH_TOKEN/GITHUB_TOKEN in this shell, or set COPILOT_GITHUB_TOKEN to a " +
        "Copilot-enabled token (gho_/ghu_/github_pat_).\n"
    );
    return;
  }
  process.stderr.write(`[sre-agent] Copilot auth ok (${status.authType ?? "user"}${who})${tail}\n`);
};

/**
 * Run the Copilot device-flow login, then reconnect the engine so the new
 * credential takes effect (the SDK runtime resolves auth at start(), so a fresh
 * login is invisible until we restart). Login runs FIRST, before tearing down
 * the engine, so a cancelled/failed login leaves the running engine intact
 * rather than wedged. After restart we re-probe auth: a clean `copilot login`
 * exit does not prove the SDK now accepts the credential, so surface the real
 * post-login status instead of a blind "complete".
 */
const reloginCopilot = async (engine: ChatEngine, config: AgentConfig): Promise<void> => {
  await copilotLogin({ home: config.copilot.home });
  await engine.stop();
  await engine.start();
  try {
    const status = await engine.getAuthStatus();
    if (!status.isAuthenticated) {
      process.stderr.write("[sre-agent] Still NOT authenticated after login — see /login guidance.\n");
      return;
    }
    logCopilotAuthStatus(status, config, "after login");
  } catch (e) {
    process.stderr.write(
      `[sre-agent] login done, but could not confirm auth status: ${e instanceof Error ? e.message : String(e)}\n`
    );
  }
};

/**
 * Seat-mode preflight, mirroring the `az` doctor: confirm the Copilot runtime
 * resolved a usable credential before the first turn, so the user gets an
 * actionable login prompt instead of an opaque 403 mid-conversation. On a
 * non-interactive terminal we can't run the device flow, so fail with guidance.
 */
const ensureCopilotAuth = async (
  engine: ChatEngine,
  config: AgentConfig,
  confirm: (summary: string) => Promise<boolean>
): Promise<void> => {
  // Unmissable build stamp: if this line is absent at startup, you are running a
  // stale dist (the preflight code did not load) — rebuild before debugging auth.
  process.stderr.write("[sre-agent] checking Copilot seat auth (auth.getStatus)…\n");
  let status;
  try {
    status = await engine.getAuthStatus();
  } catch (e) {
    // Don't block startup, but never swallow this silently — a failing status
    // probe is itself evidence (e.g. the runtime can't reach the auth endpoint).
    process.stderr.write(
      `[sre-agent] could not read Copilot auth status: ${e instanceof Error ? e.message : String(e)}\n`
    );
    return;
  }
  if (status.isAuthenticated) {
    logCopilotAuthStatus(status, config);
    return;
  }
  process.stderr.write("[sre-agent] Copilot is not authenticated.\n");
  if (stdin.isTTY === false) {
    throw new Error(
      "Copilot is not logged in. Run `copilot login`, or set COPILOT_GITHUB_TOKEN " +
        "(a gho_/ghu_/github_pat_ token) before starting the agent."
    );
  }
  const ok = await confirm("Log in to GitHub Copilot now?");
  if (!ok) {
    throw new Error(
      "Copilot login required. Re-run after `copilot login`, or set COPILOT_GITHUB_TOKEN."
    );
  }
  await reloginCopilot(engine, config);
};

const main = async () => {
  // Fail fast on bad/missing agent config before touching the SDK, runtime, or az.
  const config = loadAgentConfig();
  process.stderr.write(
    `[sre-agent] config ok (llm=${config.llm.mode}/${config.llm.model}, ado=${config.adoAuthMode})\n`
  );

  // When ADO runs through the Azure CLI, verify the session is logged in before
  // we spin up the SDK — a clear "run az login" beats an opaque tool failure
  // mid-conversation. PAT mode skips this preflight.
  if (config.adoAuthMode === "azcli") {
    process.stderr.write("[sre-agent] checking Azure CLI login (az account show)…\n");
    await runDoctor(config.raw.AZ_PATH);
    process.stderr.write("[sre-agent] az login ok\n");
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

  process.stderr.write(
    `[sre-agent] connecting to Copilot (${config.llm.mode} mode, model ${config.llm.model})… ` +
      "first run can take a while as the Copilot runtime starts\n"
  );
  await engine.start();

  // Seat auth preflight: catch a missing/unusable Copilot credential here, with
  // an in-tool login, rather than letting the first turn fail with a raw 403.
  if (config.llm.mode === "seat") {
    await ensureCopilotAuth(engine, config, confirm);
  }

  stdout.write(
    "SRE agent ready. Ask about incidents, changes, SLA risk, or ADO work items. " +
      "Type /help for workflow commands. " +
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
    // /help and /login are handled locally — never sent to the model.
    if (line === "/help") {
      stdout.write(HELP_TEXT);
      continue;
    }
    if (line === "/login") {
      try {
        await reloginCopilot(engine, config);
      } catch (e) {
        process.stderr.write(
          `[sre-agent] login failed: ${e instanceof Error ? e.message : String(e)}\n`
        );
      }
      continue;
    }
    interrupted = false;
    try {
      // Slash workflow commands expand to a seed prompt; everything else is
      // sent verbatim.
      const wf = buildWorkflowPrompt(line);
      await engine.send(wf ?? line);
      stdout.write("\n");
    } catch (e) {
      // A transport failure or sendAndWait timeout must not kill the REPL.
      process.stderr.write(
        `\n[sre-agent] turn failed: ${e instanceof Error ? e.message : String(e)}\n`
      );
      // Turn an opaque Copilot 403 into an actionable next step.
      if (isCopilotAuthError(e)) {
        process.stderr.write(
          "[sre-agent] That looks like a Copilot auth failure. Type /login to re-authenticate. " +
            "If GH_TOKEN/GITHUB_TOKEN is set in this shell, unset it or set COPILOT_GITHUB_TOKEN " +
            "to a Copilot-enabled token (gho_/ghu_/github_pat_).\n"
        );
      }
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
