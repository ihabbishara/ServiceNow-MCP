import { describe, it, expect } from "vitest";
import { validateFile, ACCEPTED_EXTS } from "../client/src/views/sources-validate.js";

describe("validateFile", () => {
  it("accepts a supported, in-size file", () => {
    expect(validateFile({ name: "a.pdf", size: 100 }, 1000)).toEqual({ ok: true });
  });
  it("rejects an unsupported extension", () => {
    expect(validateFile({ name: "deck.ppt", size: 1 }, 1000)).toEqual({ ok: false, reason: "unsupported format: .ppt" });
  });
  it("rejects an oversize file", () => {
    const r = validateFile({ name: "a.pdf", size: 2000 }, 1000);
    expect(r.ok).toBe(false);
  });
  it("exposes the accepted extension list", () => {
    expect(ACCEPTED_EXTS).toEqual(["pdf", "docx", "xlsx", "pptx", "csv", "txt"]);
  });
});
