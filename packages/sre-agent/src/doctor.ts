import { CopilotClient } from "@github/copilot-sdk";
import { AzRunner, type ExecFn } from "@sre/core";
import { loadAgentConfig, type AgentConfig } from "./config.js";
import { buildClientOptions } from "./engine/engine.js";

/**
 * Preflight: confirm the Azure CLI is logged in. `az account show` exits 0 only
 * when a session is active. On any failure, throw a remediation message guiding
 * the user to `az login` (and the azure-devops extension).
 *
 * Runs through AzRunner so the Windows `az.cmd` handling (cmd.exe + quoting)
 * lives in one place and the preflight uses the exact same invocation as the
 * real `az boards` calls.
 */
export const runDoctor = async (azPath = "az", exec?: ExecFn): Promise<void> => {
  try {
    await new AzRunner(azPath, exec).json(["account", "show"]);
  } catch {
    throw new Error(
      "Azure CLI is not logged in. Run `az login` (and `az extension add --name azure-devops`) before starting the agent."
    );
  }
};

/** Outcome of a single `sre-agent doctor` check. */
export interface CheckResult {
  name: string;
  ok: boolean;
  /** Short context shown after the name (e.g. the version found). */
  detail?: string;
  /** Remediation shown only when `ok` is false. */
  fix?: string;
}

/**
 * Render check results as a ✓/✗ checklist with a fix line under each failure
 * and a status footer. Pure — the IO checks below build the `CheckResult[]`.
 */
export const summarizeDoctor = (results: CheckResult[]): { text: string; allOk: boolean } => {
  const lines = results.map((r) => {
    const mark = r.ok ? "✓" : "✗";
    const detail = r.detail ? ` — ${r.detail}` : "";
    const fix = !r.ok && r.fix ? `\n      fix: ${r.fix}` : "";
    return `  ${mark} ${r.name}${detail}${fix}`;
  });
  const allOk = results.every((r) => r.ok);
  const footer = allOk
    ? "\nAll checks passed. Run `npm start` to chat."
    : "\nSome checks failed — fix the items above, then re-run `npm start -- doctor`.";
  return { text: lines.join("\n") + "\n" + footer, allOk };
};

const checkNode = (): CheckResult => {
  const major = Number(process.versions.node.split(".")[0]);
  return {
    name: "Node.js >= 20",
    ok: major >= 20,
    detail: `v${process.versions.node}`,
    fix: "Install Node.js 20 or newer (https://nodejs.org)."
  };
};

const checkConfig = (): { result: CheckResult; config?: AgentConfig } => {
  try {
    const config = loadAgentConfig();
    return {
      config,
      result: {
        name: "Configuration",
        ok: true,
        detail: `llm=${config.llm.mode}/${config.llm.model}, ado=${config.adoAuthMode}`
      }
    };
  } catch (e) {
    return {
      result: {
        name: "Configuration",
        ok: false,
        detail: e instanceof Error ? e.message.split("\n")[0] : String(e),
        fix: "Run `npm start -- init` to scaffold a .env, or fix the values it reports."
      }
    };
  }
};

const checkAzLogin = async (azPath: string): Promise<CheckResult> => {
  try {
    await new AzRunner(azPath).json(["account", "show"]);
    return { name: "Azure CLI login", ok: true };
  } catch {
    return {
      name: "Azure CLI login",
      ok: false,
      detail: "`az account show` failed",
      fix: "Run `az login` (Microsoft Entra)."
    };
  }
};

const checkAzBoardsExtension = async (azPath: string): Promise<CheckResult> => {
  try {
    await new AzRunner(azPath).json(["extension", "show", "--name", "azure-devops"]);
    return { name: "azure-devops CLI extension", ok: true };
  } catch {
    return {
      name: "azure-devops CLI extension",
      ok: false,
      detail: "extension not installed",
      fix: "Run `az extension add --name azure-devops`."
    };
  }
};

const checkCopilotAuth = async (config: AgentConfig): Promise<CheckResult> => {
  const client = new CopilotClient(buildClientOptions(config));
  try {
    await client.start();
    const status = await client.getAuthStatus();
    if (!status.isAuthenticated) {
      return {
        name: "Copilot seat auth",
        ok: false,
        detail: "not authenticated",
        fix: "Start the agent and run /login, or set COPILOT_GITHUB_TOKEN."
      };
    }
    if (status.authType === "env" && !config.copilot.githubToken) {
      return {
        name: "Copilot seat auth",
        ok: false,
        detail: `using ambient env token (${status.login ?? "?"})`,
        fix: "Unset GH_TOKEN/GITHUB_TOKEN (the agent strips them by default — rebuild), or set COPILOT_GITHUB_TOKEN."
      };
    }
    return {
      name: "Copilot seat auth",
      ok: true,
      detail: `${status.authType ?? "user"}${status.login ? `, ${status.login}` : ""}`
    };
  } catch (e) {
    return {
      name: "Copilot seat auth",
      ok: false,
      detail: e instanceof Error ? e.message : String(e),
      fix: "Ensure @github/copilot is installed and you have a Copilot seat."
    };
  } finally {
    await client.stop().catch(() => {});
  }
};

/**
 * Run every prerequisite check and return a printable summary. Config is loaded
 * first; az checks run only in azcli mode; the Copilot check is skipped in BYOK
 * mode (auth is via the provider key, not a seat).
 */
export const runChecks = async (): Promise<{ text: string; allOk: boolean }> => {
  const results: CheckResult[] = [checkNode()];
  const { result: configResult, config } = checkConfig();
  results.push(configResult);

  if (config) {
    if (config.adoAuthMode === "azcli") {
      results.push(await checkAzLogin(config.raw.AZ_PATH));
      results.push(await checkAzBoardsExtension(config.raw.AZ_PATH));
    }
    if (config.llm.mode === "seat") {
      results.push(await checkCopilotAuth(config));
    }
  }
  return summarizeDoctor(results);
};
