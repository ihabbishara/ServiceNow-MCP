import { execFile } from "node:child_process";
import { promisify } from "node:util";

export type ExecFn = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
const defaultExec: ExecFn = promisify(execFile) as unknown as ExecFn;

/**
 * Thin wrapper around the `az` CLI. Appends `--output json --only-show-errors`,
 * parses stdout as JSON on success, and throws with a stderr snippet on a
 * non-zero exit. Success is gated on the exec promise resolving (exit code 0);
 * `az` writes warnings to stderr even on success, so stderr is ignored.
 */
export class AzRunner {
  constructor(
    private readonly azPath = "az",
    private readonly exec: ExecFn = defaultExec
  ) {}

  async json<T>(args: string[]): Promise<T> {
    const full = [...args, "--output", "json", "--only-show-errors"];
    try {
      const { stdout } = await this.exec(this.azPath, full);
      return JSON.parse(stdout) as T;
    } catch (err: unknown) {
      const e = err as { stderr?: string; message?: string };
      const msg = (e?.stderr || e?.message || String(err)).toString().slice(0, 300);
      throw new Error(`az ${args.slice(0, 3).join(" ")} failed: ${msg}`);
    }
  }
}
