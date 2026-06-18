import { AzRunner, type ExecFn } from "@sre/core";

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
