// Ambient type shim for the pdf-parse inner module path.
// The @types/pdf-parse package only declares the top-level module; the inner path
// `pdf-parse/lib/pdf-parse.js` is used here to avoid its package index reading a
// sample PDF at import time (a side-effect of pdf-parse v1's debug code).
declare module "pdf-parse/lib/pdf-parse.js" {
  function pdfParse(
    dataBuffer: Buffer,
    options?: { pagerender?: (pageData: unknown) => string | Promise<string>; max?: number }
  ): Promise<{ text: string; numpages: number; info: unknown; metadata: unknown }>;
  export = pdfParse;
}
