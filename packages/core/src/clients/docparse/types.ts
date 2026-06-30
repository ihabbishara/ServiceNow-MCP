export type DocFormat = "docx" | "xlsx" | "pptx" | "pdf" | "csv" | "txt";

export type Parsers = Record<DocFormat, (b: Buffer) => Promise<string>>;

export type ExtractResult = { text: string } | { skipped: string };
