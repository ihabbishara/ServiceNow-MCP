import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface DeviceCodeInfo {
  verificationUri: string;
  userCode: string;
}

/**
 * Extract the device-flow verification URL + user code from accumulated
 * `copilot login` stdout. The two can print on separate lines, so callers pass
 * the running buffer, not a single chunk. Returns undefined until BOTH are seen.
 */
export const parseDeviceCode = (buffer: string): DeviceCodeInfo | undefined => {
  const verificationUri = buffer.match(/https?:\/\/\S*github\.com\/login\/device\S*/i)?.[0];
  const userCode = buffer.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/)?.[0];
  if (verificationUri && userCode) return { verificationUri, userCode };
  return undefined;
};

/**
 * Minimal child-process surface the login helper needs: subscribe to the two
 * terminal events and read stdout. Keeping the type this narrow lets tests inject
 * a plain EventEmitter (with a `.stdout` EventEmitter) without standing up a
 * real process.
 */
export interface LoginChild {
  stdout: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown };
  on(event: "close", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: { stdio: ["ignore", "pipe", "inherit"]; env: NodeJS.ProcessEnv }
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
  /** Invoked once when the device-flow URL + user code are parsed from stdout. */
  onDeviceCode?: (info: DeviceCodeInfo) => void;
}

/**
 * Resolve the EXACT runtime entry point the SDK spawns, mirroring
 * `CopilotClient`'s `getBundledCliPath` (and its `COPILOT_CLI_PATH` override):
 * the pure-JS `@github/copilot/index.js`.
 *
 * Critically NOT `npm-loader.js` (the `copilot` bin): npm-loader prefers the
 * native platform binary and falls back to a JS path that hard-requires Node
 * v24. The SDK always runs `node index.js`, which has no such gate. Logging in
 * through the same index.js guarantees the device-flow OAuth lands in the
 * credential store the SDK's runtime later reads — and that login works on the
 * Node versions the agent itself runs on (v22+).
 */
export const resolveSdkRuntime = (): string => {
  // Honor the same override the SDK checks first, so login and the chat client
  // never diverge when COPILOT_CLI_PATH is set.
  const override = process.env.COPILOT_CLI_PATH;
  if (override) return override;
  // ESM `import.meta.resolve` honors the package's "import" export condition
  // (`@github/copilot/sdk`), which CJS `require.resolve` cannot. Up two dirs
  // from the sdk entry is the package root, where index.js lives.
  const resolve = import.meta.resolve;
  if (typeof resolve === "function") {
    const sdkPath = fileURLToPath(resolve("@github/copilot/sdk"));
    return join(dirname(dirname(sdkPath)), "index.js");
  }
  const require = createRequire(import.meta.url);
  for (const base of require.resolve.paths("@github/copilot") ?? []) {
    const candidate = join(base, "@github", "copilot", "index.js");
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    "Could not find the @github/copilot runtime (index.js). Ensure @github/copilot is installed."
  );
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
  const bin = (opts.resolveBin ?? resolveSdkRuntime)();
  const execPath = opts.execPath ?? process.execPath;
  const env: NodeJS.ProcessEnv = { ...(opts.env ?? process.env) };
  if (opts.home) env.COPILOT_HOME = opts.home;

  // A .js entry runs under node (`node index.js login`), exactly as the SDK
  // spawns it; a native binary override runs directly (`copilot login`).
  const isJs = bin.endsWith(".js");
  const command = isJs ? execPath : bin;
  const args = isJs ? [bin, "login"] : ["login"];

  return new Promise<void>((resolve, reject) => {
    const child = spawnFn(command, args, { stdio: ["ignore", "pipe", "inherit"], env });
    let buffer = "";
    let fired = false;
    child.stdout.on("data", (chunk) => {
      if (fired) return;
      buffer += chunk.toString();
      if (opts.onDeviceCode) {
        const info = parseDeviceCode(buffer);
        if (info) {
          fired = true;
          opts.onDeviceCode(info);
        }
      }
    });
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
 *
 * Only ever applied to errors THROWN out of `session.sendAndWait` — i.e.
 * Copilot transport/turn failures. Tool failures (ServiceNow/ADO HTTP 403 etc.)
 * are returned to the model as tool results, not thrown out of the turn, so the
 * bare numeric match here won't misfire on a downstream 403. Worst case it adds
 * one extra hint line after an already-failed turn.
 */
export const isCopilotAuthError = (err: unknown): boolean => {
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return /authorization error|unauthorized|\byou may need to run \/login\b|\b401\b|\b403\b/i.test(
    message
  );
};
