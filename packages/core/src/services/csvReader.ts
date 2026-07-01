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
  // Trust boundary: the filename comes from a tool caller. Reject anything that
  // is not a bare filename in `dir`, then confirm the resolved path stays inside.
  if (filename !== basename(filename) || filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
    throw new Error(`invalid filename: ${filename}`);
  }
  if (extname(filename).toLowerCase() !== ".csv") throw new Error("only .csv files are allowed");
  const base = resolve(dir);
  const full = resolve(base, filename);
  if (full !== `${base}${sep}${filename}` && !full.startsWith(`${base}${sep}`)) {
    throw new Error("path escapes the CSV directory");
  }
  const st = await fs.stat(full);
  if (st.size > maxBytes) throw new Error(`file exceeds ${maxBytes} bytes`);

  const text = await fs.readFile(full, "utf8");
  const matrix = parse(text, { skip_empty_lines: true, trim: true }) as string[][];
  if (!matrix.length) return { headers: [], rows: [], rowCount: 0 };
  const headers = matrix[0];
  const rows = matrix.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""])));
  return { headers, rows, rowCount: rows.length };
};
