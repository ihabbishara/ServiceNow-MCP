import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Seams for testing the resolution order without touching the real filesystem.
 */
export interface DotenvDeps {
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  home?: string;
  cwd?: string;
  /** Override the package-local `.env` location (computed from import.meta otherwise). */
  packageEnvPath?: string;
  /** Override the loader side-effect; defaults to Node's process.loadEnvFile. */
  load?: (path: string) => void;
}

/**
 * The `.env` that ships next to this package (packages/sre-agent/.env), the
 * documented default location. Computed relative to the compiled file
 * (dist/config/env.js → up two dirs → package root).
 */
export const packageEnvPath = (): string =>
  join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".env");

/**
 * First existing `.env` in precedence order:
 *   1. $SRE_AGENT_ENV  (explicit override)
 *   2. ./.env          (the directory you run from)
 *   3. packages/sre-agent/.env  (the documented clone-local default)
 *   4. ~/.sre-agent/.env        (per-user, machine-wide)
 * Returns undefined when none exist — config may still be set in the real
 * environment, so callers should not treat "no file" as fatal.
 */
export const resolveDotenvPath = (deps: DotenvDeps = {}): string | undefined => {
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? existsSync;
  const home = deps.home ?? homedir();
  const cwd = deps.cwd ?? process.cwd();
  const pkgEnv = deps.packageEnvPath ?? packageEnvPath();

  const candidates = [
    env.SRE_AGENT_ENV,
    join(cwd, ".env"),
    pkgEnv,
    join(home, ".sre-agent", ".env")
  ].filter((p): p is string => Boolean(p));

  return candidates.find((p) => exists(p));
};

/**
 * Resolve and load a `.env` into process.env so the agent runs without the
 * `--env-file` flag. Returns the loaded path (or undefined if none found).
 */
export const loadDotenv = (deps: DotenvDeps = {}): string | undefined => {
  const path = resolveDotenvPath(deps);
  if (path) (deps.load ?? ((p) => process.loadEnvFile(p)))(path);
  return path;
};
