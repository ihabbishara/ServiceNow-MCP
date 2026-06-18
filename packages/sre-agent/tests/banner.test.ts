import { describe, it, expect, vi } from "vitest";
import { banner, supportsColor, printBanner, chooseLayout } from "../src/banner.js";

/** Max display width (code-point count) across the lines of a block. */
const maxWidth = (s: string): number => Math.max(...s.split("\n").map((l) => [...l].length));

describe("supportsColor", () => {
  it("is true on a TTY with no NO_COLOR and a normal TERM", () => {
    expect(supportsColor({ TERM: "xterm-256color" }, true)).toBe(true);
  });

  it("is false when NO_COLOR is set (any value, per no-color.org)", () => {
    expect(supportsColor({ NO_COLOR: "" }, true)).toBe(false);
    expect(supportsColor({ NO_COLOR: "1" }, true)).toBe(false);
  });

  it("is false when not a TTY (piped/redirected output)", () => {
    expect(supportsColor({ TERM: "xterm" }, false)).toBe(false);
  });

  it("is false for a dumb terminal", () => {
    expect(supportsColor({ TERM: "dumb" }, true)).toBe(false);
  });
});

describe("chooseLayout", () => {
  it("uses the wide wordmark when the terminal is at least 98 columns", () => {
    expect(chooseLayout(120)).toBe("wide");
    expect(chooseLayout(98)).toBe("wide");
  });

  it("stacks when the terminal is narrower than the wide wordmark", () => {
    expect(chooseLayout(97)).toBe("stacked");
    expect(chooseLayout(80)).toBe("stacked");
  });
});

describe("banner", () => {
  it("contains the block art and the tagline", () => {
    const out = banner({ color: false, columns: 120 });
    expect(out).toContain("█"); // block glyphs present
    expect(out).toMatch(/ServiceNow.*Azure DevOps/);
  });

  it("renders the wide single-line wordmark (98 cols) on a wide terminal", () => {
    expect(maxWidth(banner({ color: false, columns: 120 }))).toBe(98);
  });

  it("renders the stacked wordmark (<=72 cols) on a narrow terminal", () => {
    expect(maxWidth(banner({ color: false, columns: 80 }))).toBe(72);
  });

  it("emits no ANSI escape codes when color is off", () => {
    expect(banner({ color: false })).not.toContain("\x1b[");
  });

  it("wraps output in ANSI escapes when color is on", () => {
    expect(banner({ color: true })).toContain("\x1b[");
  });
});

describe("printBanner", () => {
  it("writes the banner once through the provided sink", () => {
    const write = vi.fn();
    printBanner(write, { color: false });
    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0][0]).toContain("ServiceNow");
  });
});
