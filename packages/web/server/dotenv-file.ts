import { readFile, writeFile } from "node:fs/promises";

export const parseEnv = (text: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
};

export const serializeEnv = (vars: Record<string, string>): string =>
  Object.entries(vars)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n") + "\n";

export const readEnvFile = async (path: string): Promise<Record<string, string>> => {
  try {
    return parseEnv(await readFile(path, "utf8"));
  } catch {
    return {};
  }
};

export const writeEnvFile = (path: string, vars: Record<string, string>): Promise<void> =>
  writeFile(path, serializeEnv(vars), "utf8");
