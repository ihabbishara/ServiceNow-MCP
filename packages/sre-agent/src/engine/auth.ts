import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/**
 * Minimal child-process surface the login helper needs: subscribe to the two
 * terminal events. Keeping the type this narrow lets tests inject a plain
 * EventEmitter without standing up a real process.
 */
export interface LoginChild {
  on(event: "close", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: { stdio: "inherit"; env: NodeJS.ProcessEnv }
) => LoginChild;

export interface CopilotLoginOptions {
  /**
   * COPILOT_HOME to write the credential into. Set this to the same value the
   * SDK runtime uses so the login and the chat client share one store. When
   * omitted, the runtime default (~/.copilot) is used for both.
   */
  home?: string;
  /** Injected in tests. Defaults to node:child_process spawn. */
  spawnFn?: SpawnFn;
  /** Injected in tests. Defaults to the bundled @github/copilot launcher. */
  resolveBin?: () => string;
  /** Injected in tests. Defaults to the current Node binary. */
  execPath?: string;
  /** Base env for the child. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the launcher of the SAME bundled runtime the SDK spawns
 * (`@github/copilot`'s `npm-loader.js`, the `copilot` bin). Logging in through
 * this exact launcher guarantees the device-flow OAuth lands in the credential
 * store the SDK's runtime later reads — no version/path drift between "logged
 * in" and "still 403".
 */
const defaultResolveBin = (): string => {
  const require = createRequire(import.meta.url);
  const pkgJsonPath = require.resolve("@github/copilot/package.json");
  return join(dirname(pkgJsonPath), "npm-loader.js");
};

/**
 * Run the Copilot device-flow login in-process: spawn the bundled `copilot
 * login` with inherited stdio so its `github.com/login/device` URL + user code
 * print straight to the terminal and the user completes it in a browser.
 * Resolves once the login process exits 0 (credential stored); rejects on a
 * non-zero exit or spawn failure.
 *
 * Mirrors the `az` doctor preflight: surface the auth step as a first-class,
 * actionable flow instead of an opaque mid-conversation 403.
 */
export const copilotLogin = (opts: CopilotLoginOptions = {}): Promise<void> => {
  const spawnFn = opts.spawnFn ?? (spawn as unknown as SpawnFn);
  const bin = (opts.resolveBin ?? defaultResolveBin)();
  const execPath = opts.execPath ?? process.execPath;
  const env: NodeJS.ProcessEnv = { ...(opts.env ?? process.env) };
  if (opts.home) env.COPILOT_HOME = opts.home;

  return new Promise<void>((resolve, reject) => {
    const child = spawnFn(execPath, [bin, "login"], { stdio: "inherit", env });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`copilot login exited with code ${code ?? "unknown"}`));
    });
  });
};

/**
 * Whether an error looks like a Copilot authorization failure — the
 * "Authorization error, you may need to run /login" turn failure the SDK
 * surfaces, or a bare 401/403 transport error. Used to turn an opaque turn
 * failure into an actionable "run /login" hint.
 */
export const isCopilotAuthError = (err: unknown): boolean => {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return /authorization error|unauthorized|\byou may need to run \/login\b|\b401\b|\b403\b/i.test(
    message
  );
};
