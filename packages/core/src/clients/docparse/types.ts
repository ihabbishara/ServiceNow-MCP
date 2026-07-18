export type DocFormat = "docx" | "xlsx" | "pptx" | "pdf" | "csv" | "txt" | "md";

export type Parsers = Record<DocFormat, (b: Buffer) => Promise<string>>;

export type ExtractResult = { text: string } | { skipped: string };
