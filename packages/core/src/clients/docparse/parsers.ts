import type { Parsers } from "./types.js";

/**
 * Real text extractors. Heavy parser libs are dynamically imported so they load
 * only when a document is actually ingested. `pdf-parse` is imported via its
 * inner module path to avoid its package index reading a sample PDF at import.
 */
export const defaultParsers: Parsers = {
  docx: async (b) => {
    const mammoth = await import("mammoth");
    const { value } = await mammoth.extractRawText({ buffer: b });
    return value;
  },
  xlsx: async (b) => {
    const op = await import("officeparser");
    const ast = await op.parseOffice(b);
    return ast.toText();
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
  },
  csv: async (b) => b.toString("utf8"),
  txt: async (b) => b.toString("utf8")
};
