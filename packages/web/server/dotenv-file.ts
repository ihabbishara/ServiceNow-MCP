import { readFile, writeFile } from "node:fs/promises";

export const parseEnv = (text: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2) {
      const q = value[0];
      if ((q === '"' || q === "'") && value[value.length - 1] === q) {
        value = value.slice(1, -1);
        if (q === '"') value = value.replace(/\\(.)/g, (_, c) => (c === "n" ? "\n" : c));
      }
    }
    out[key] = value;
  }
  return out;
};

const needsQuoting = (v: string): boolean => v === "" || /[\s#"'=]/.test(v) || v.includes("\n");

export const serializeEnv = (vars: Record<string, string>): string =>
  Object.entries(vars)
    .map(([k, v]) => {
      if (!needsQuoting(v)) return `${k}=${v}`;
      const esc = v.replace(/([\\"])/g, "\\$1").replace(/\n/g, "\\n");
      return `${k}="${esc}"`;
    })
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
