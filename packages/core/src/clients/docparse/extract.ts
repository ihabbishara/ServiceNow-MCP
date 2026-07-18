import type { Parsers, ExtractResult, DocFormat } from "./types.js";

const EXT_TO_FORMAT: Record<string, DocFormat> = {
  docx: "docx",
  xlsx: "xlsx",
  pptx: "pptx",
  pdf: "pdf",
  csv: "csv",
  txt: "txt",
  md: "md"
};

export const extOf = (name: string): string => {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
};

export const formatOf = (name: string): DocFormat | null => EXT_TO_FORMAT[extOf(name)] ?? null;

/** Extract plain text from a document buffer. Unknown format or parser failure → a skip reason. */
export const extractText = async (
  name: string,
  bytes: Buffer,
  parsers: Parsers
): Promise<ExtractResult> => {
  const format = formatOf(name);
  if (!format) return { skipped: `unsupported format: .${extOf(name)}` };
  try {
    const text = await parsers[format](bytes);
    return { text };
  } catch (err) {
    return { skipped: `parse failed: ${err instanceof Error ? err.message : String(err)}` };
  }
};
