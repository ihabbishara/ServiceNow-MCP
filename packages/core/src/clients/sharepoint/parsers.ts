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
  }
};
