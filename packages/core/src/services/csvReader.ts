import { promises as fs } from "node:fs";
import { resolve, sep, extname, basename } from "node:path";
import { parse } from "csv-parse/sync";

export interface CsvTable {
  headers: string[];
  rows: Record<string, string>[];
  rowCount: number;
}

export interface CsvFileInfo {
  name: string;
  sizeBytes: number;
  modified: string; // ISO 8601
}

export const listCsvFiles = async (dir: string): Promise<CsvFileInfo[]> => {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const out: CsvFileInfo[] = [];
  for (const e of entries) {
    if (!e.isFile() || extname(e.name).toLowerCase() !== ".csv") continue;
    const st = await fs.stat(resolve(dir, e.name));
    out.push({ name: e.name, sizeBytes: st.size, modified: st.mtime.toISOString() });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
};

export const readCsvFile = async (dir: string, filename: string, maxBytes: number): Promise<CsvTable> => {
  // Trust boundary: `filename` comes from a tool caller.
  // Layer 1 — must be a bare basename with no traversal tokens.
  if (filename !== basename(filename) || filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
    throw new Error(`invalid filename: ${filename}`);
  }
  if (extname(filename).toLowerCase() !== ".csv") throw new Error("only .csv files are allowed");

  // Realpath the directory root so a symlinked root (e.g. /var -> /private/var on
  // macOS, or /tmp) does not cause a false-positive containment failure below.
  const base = await fs.realpath(resolve(dir));

  // Layer 2 — the lexically resolved path must stay inside `base`. Independent of
  // Layer 1: an absolute filename would resolve outside `base` and be rejected here.
  const full = resolve(base, filename);
  if (!full.startsWith(`${base}${sep}`)) throw new Error("path escapes the CSV directory");

  // Layer 3 — resolve symlinks and re-assert containment. fs.stat/readFile follow
  // symlinks, so a link inside `base` pointing outside must not be read.
  const real = await fs.realpath(full);
  if (!real.startsWith(`${base}${sep}`)) throw new Error("path escapes the CSV directory");

  const st = await fs.stat(real);
  if (st.size > maxBytes) throw new Error(`file exceeds ${maxBytes} bytes`);
  const text = await fs.readFile(real, "utf8");
  const matrix = parse(text, { skip_empty_lines: true, trim: true }) as string[][];
  if (!matrix.length) return { headers: [], rows: [], rowCount: 0 };
  const headers = matrix[0];
  const rows = matrix.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""])));
  return { headers, rows, rowCount: rows.length };
};
