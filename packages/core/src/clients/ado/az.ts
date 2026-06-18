import { execFile } from "node:child_process";
import { promisify } from "node:util";

export interface ExecOptions {
  timeout?: number;
  maxBuffer?: number;
}
export type ExecFn = (
  file: string,
  args: string[],
  options?: ExecOptions
) => Promise<{ stdout: string; stderr: string }>;

const execFileP = promisify(execFile);

// Windows command-line quoting for a single argument (cross-spawn style): wrap
// in double quotes when it contains whitespace or quotes, escaping embedded
// double-quotes and trailing backslashes. WIQL uses single quotes + brackets,
// which cmd treats literally inside double quotes.
const winQuote = (a: string): string => {
  if (a === "") return '""';
  if (!/[\s"]/.test(a)) return a;
  return '"' + a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1') + '"';
};

// On Windows the Azure CLI is `az.cmd` (a batch script). Node >= 20.12 refuses
// to spawn `.cmd`/`.bat` without a shell (CVE-2024-27980), and execFile never
// resolved them anyway. Run through cmd.exe with hand-quoted, verbatim args so
// the WIQL string (spaces + single quotes) survives intact. POSIX is unchanged:
// execFile the binary directly with the args array (no shell, no quoting).
const defaultExec: ExecFn = ((file: string, args: string[], options?: ExecOptions) => {
  if (process.platform === "win32") {
    const line = [file, ...args].map(winQuote).join(" ");
    return execFileP("cmd.exe", ["/d", "/s", "/c", line], {
      ...options,
      windowsVerbatimArguments: true
    });
  }
  return execFileP(file, args, options);
}) as unknown as ExecFn;

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
      // Bound a hung `az` (e.g. an interactive auth stall) and allow large
      // `az boards query` payloads (full-field results can exceed the ~1 MB
      // execFile default and reject with a confusing maxBuffer error).
      const { stdout } = await this.exec(this.azPath, full, { timeout: 30000, maxBuffer: 16 * 1024 * 1024 });
      return JSON.parse(stdout) as T;
    } catch (err: unknown) {
      const e = err as { stderr?: string; message?: string };
      const msg = (e?.stderr || e?.message || String(err)).toString().slice(0, 300);
      throw new Error(`az ${args.slice(0, 3).join(" ")} failed: ${msg}`);
    }
  }
}
