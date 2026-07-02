import { describe, it, expect } from "vitest";
import { extOf, formatOf, extractText } from "../src/clients/docparse/index.js";
import type { Parsers } from "../src/clients/docparse/index.js";

const fakeParsers = {
  docx: async () => "docx-text",
  xlsx: async () => "xlsx-text",
  pptx: async () => "pptx-text",
  pdf: async () => "pdf-text",
  csv: async (b: Buffer) => b.toString("utf8"),
  txt: async (b: Buffer) => b.toString("utf8")
} satisfies Parsers;

describe("docparse", () => {
  it("maps modern extensions including csv/txt", () => {
    expect(formatOf("a.pdf")).toBe("pdf");
    expect(formatOf("a.CSV")).toBe("csv");
    expect(formatOf("notes.txt")).toBe("txt");
    expect(extOf("x.PPTX")).toBe("pptx");
  });

  it("rejects legacy and unknown formats", () => {
    expect(formatOf("deck.ppt")).toBeNull();
    expect(formatOf("book.xls")).toBeNull();
    expect(formatOf("noext")).toBeNull();
  });

  it("extracts text for a known format", async () => {
    const r = await extractText("data.csv", Buffer.from("a,b\n1,2"), fakeParsers);
    expect(r).toEqual({ text: "a,b\n1,2" });
  });

  it("skips an unsupported format", async () => {
    const r = await extractText("deck.ppt", Buffer.from(""), fakeParsers);
    expect(r).toEqual({ skipped: "unsupported format: .ppt" });
  });

  it("skips on parser failure", async () => {
    const throwing = {
      ...fakeParsers,
      pdf: async () => {
        throw new Error("bad pdf");
      }
    };
    const r = await extractText("x.pdf", Buffer.from(""), throwing);
    expect(r).toEqual({ skipped: "parse failed: bad pdf" });
  });
});
