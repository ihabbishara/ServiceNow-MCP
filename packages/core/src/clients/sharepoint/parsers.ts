import type { Parsers } from "./types.js";

/**
 * Real text extractors. Imports are dynamic so the heavy parser libs load only
 * when SharePoint is actually used. `pdf-parse` is imported via its inner module
 * path to avoid its package index reading a sample PDF at import time.
 */
export const defaultParsers: Parsers = {
  docx: async (b) => {
    const mammoth = await import("mammoth");
    const { value } = await mammoth.extractRawText({ buffer: b });
    return value;
  },
  xlsx: async (b) => {
    const XLSX = await import("xlsx");
    const wb = XLSX.read(b, { type: "buffer" });
    return wb.SheetNames.map((n) => `# ${n}\n${XLSX.utils.sheet_to_csv(wb.Sheets[n])}`).join("\n\n");
  },
  pptx: async (b) => {
    const op = await import("officeparser");
    const ast = await op.parseOffice(b);
    return ast.toText();
  },
  pdf: async (b) => {
    const { default: pdf } = await import("pdf-parse/lib/pdf-parse.js");
    const { text } = await pdf(b);
    return text;
  }
};
