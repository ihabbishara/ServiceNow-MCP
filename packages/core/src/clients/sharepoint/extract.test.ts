import { describe, it, expect, vi } from "vitest";
import { extractText, formatOf } from "./extract.js";
import type { Parsers } from "./types.js";

const parsers: Parsers = {
  docx: vi.fn(async () => "docx-text"),
  xlsx: vi.fn(async () => "xlsx-text"),
  pptx: vi.fn(async () => "pptx-text"),
  pdf: vi.fn(async () => "pdf-text"),
  csv: vi.fn(async (b) => b.toString("utf8")),
  txt: vi.fn(async (b) => b.toString("utf8"))
};

describe("formatOf", () => {
  it("maps known extensions, null otherwise", () => {
    expect(formatOf("a.DOCX")).toBe("docx");
    expect(formatOf("a.pdf")).toBe("pdf");
    expect(formatOf("a.doc")).toBeNull();   // legacy binary not supported
    expect(formatOf("a.txt")).toBe("txt");
  });
});

describe("extractText", () => {
  it("dispatches by format", async () => {
    expect(await extractText("r.docx", Buffer.from(""), parsers)).toEqual({ text: "docx-text" });
    expect(await extractText("s.xlsx", Buffer.from(""), parsers)).toEqual({ text: "xlsx-text" });
  });

  it("skips unsupported formats", async () => {
    expect(await extractText("notes.one", Buffer.from(""), parsers)).toEqual({
      skipped: "unsupported format: .one"
    });
  });

  it("turns a parser error into a skip", async () => {
    const boom: Parsers = { ...parsers, pdf: vi.fn(async () => { throw new Error("corrupt"); }) };
    expect(await extractText("x.pdf", Buffer.from(""), boom)).toEqual({ skipped: "parse failed: corrupt" });
  });
});
