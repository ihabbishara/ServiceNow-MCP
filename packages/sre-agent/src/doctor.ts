import { execFile } from "node:child_process";
import { promisify } from "node:util";

type ExecFn = (
  file: string,
  args: string[],
  options?: { timeout?: number }
) => Promise<{ stdout: string; stderr: string }>;
const defaultExec = promisify(execFile) as unknown as ExecFn;

/**
 * Preflight: confirm the Azure CLI is logged in. `az account show` exits 0 only
 * when a session is active. On any failure, throw a remediation message guiding
 * the user to `az login` (and the azure-devops extension).
 */
export const runDoctor = async (azPath = "az", exec: ExecFn = defaultExec): Promise<void> => {
  try {
    // Bound a hung `az account show` so preflight can't stall forever.
    await exec(azPath, ["account", "show", "--output", "json", "--only-show-errors"], { timeout: 15000 });
  } catch {
    throw new Error(
      "Azure CLI is not logged in. Run `az login` (and `az extension add --name azure-devops`) before starting the agent."
    );
  }
};
