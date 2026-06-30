import { readFile, writeFile } from "node:fs/promises";

/**
 * Split the text after `=` into the value and any trailing inline `# comment`,
 * respecting quotes. A `#` inside quotes is part of the value; the comment is
 * whatever follows the closing quote (or the first unquoted `#`).
 */
const parseValue = (raw: string): { value: string; comment: string } => {
  if (raw === "") return { value: "", comment: "" };
  const q = raw[0];
  if (q === '"' || q === "'") {
    let i = 1;
    for (; i < raw.length; i++) {
      if (q === '"' && raw[i] === "\\") {
        i++; // skip the escaped char
        continue;
      }
      if (raw[i] === q) break;
    }
    let value = raw.slice(1, i);
    if (q === '"') value = value.replace(/\\(.)/g, (_, c) => (c === "n" ? "\n" : c));
    const after = raw.slice(i + 1);
    const hash = after.indexOf("#");
    return { value, comment: hash === -1 ? "" : after.slice(hash + 1).trim() };
  }
  const hash = raw.indexOf("#");
  if (hash === -1) return { value: raw.trim(), comment: "" };
  return { value: raw.slice(0, hash).trim(), comment: raw.slice(hash + 1).trim() };
};

/** Parse a .env into `{ key: { value, comment } }`, dropping blank/comment lines. */
export const parseEnvWithComments = (
  text: string
): Record<string, { value: string; comment: string }> => {
  const out: Record<string, { value: string; comment: string }> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    out[line.slice(0, eq).trim()] = parseValue(line.slice(eq + 1).trim());
  }
  return out;
};

/** Parse a .env into clean values (inline comments stripped). */
export const parseEnv = (text: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, { value }] of Object.entries(parseEnvWithComments(text))) out[k] = value;
  return out;
};

const needsQuoting = (v: string): boolean => v === "" || /[\s#"'=]/.test(v) || v.includes("\n");

const formatValue = (v: string): string => {
  if (!needsQuoting(v)) return v;
  const esc = v.replace(/([\\"])/g, "\\$1").replace(/\n/g, "\\n");
  return `"${esc}"`;
};

export const serializeEnv = (vars: Record<string, string>): string =>
  Object.entries(vars)
    .map(([k, v]) => `${k}=${formatValue(v)}`)
    .join("\n") + "\n";

/**
 * Rewrite `original` so each KEY in `vars` gets its new value, preserving the
 * line's trailing inline comment plus all blank lines, comment-only lines, and
 * key order. Keys not already present are appended. Keeps the user's .env
 * readable instead of flattening it the way serializeEnv does.
 */
export const updateEnvText = (original: string, vars: Record<string, string>): string => {
  const remaining = new Set(Object.keys(vars));
  const lines = original.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop(); // drop trailing-newline artifact

  const out = lines.map((raw) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return raw;
    const eq = line.indexOf("=");
    if (eq === -1) return raw;
    const key = line.slice(0, eq).trim();
    if (!remaining.has(key)) return raw;
    remaining.delete(key);
    const { comment } = parseValue(line.slice(eq + 1).trim());
    return `${key}=${formatValue(vars[key])}${comment ? ` # ${comment}` : ""}`;
  });

  for (const key of remaining) out.push(`${key}=${formatValue(vars[key])}`);
  return out.join("\n") + "\n";
};

export const readEnvFile = async (path: string): Promise<Record<string, string>> => {
  try {
    return parseEnv(await readFile(path, "utf8"));
  } catch {
    return {};
  }
};

/** Read a .env into clean values plus the inline comment per key (UI help text). */
export const readEnvFields = async (
  path: string
): Promise<{ vars: Record<string, string>; comments: Record<string, string> }> => {
  try {
    const fields = parseEnvWithComments(await readFile(path, "utf8"));
    const vars: Record<string, string> = {};
    const comments: Record<string, string> = {};
    for (const [k, { value, comment }] of Object.entries(fields)) {
      vars[k] = value;
      if (comment) comments[k] = comment;
    }
    return { vars, comments };
  } catch {
    return { vars: {}, comments: {} };
  }
};

/** Non-destructive write: merge `vars` into the existing file, preserving comments/order. */
export const writeEnvFile = async (path: string, vars: Record<string, string>): Promise<void> => {
  let original = "";
  try {
    original = await readFile(path, "utf8");
  } catch {
    /* no existing file → updateEnvText("") appends all keys */
  }
  await writeFile(path, updateEnvText(original, vars), "utf8");
};
