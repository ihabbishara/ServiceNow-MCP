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

const ORANGE = "\x1b[38;2;255;98;0m";
const hasHalfBlock = (s: string) => /[▀▄█]/.test(s) && /[▀▄]/.test(s);

describe("ING lion", () => {
  it("shows the orange lion (half-block art) when color is on and there is room", () => {
    const out = banner({ color: true, columns: 80 });
    expect(hasHalfBlock(out)).toBe(true); // half-block glyphs are unique to the lion
    expect(out).toContain(ORANGE); // painted ING orange
    expect(out).toContain("SRE AGENT");
  });

  it("falls back to the plain text wordmark (no lion, no escapes) when color is off", () => {
    const out = banner({ color: false, columns: 120 });
    expect(out).not.toContain("\x1b["); // no color codes
    expect(/[▀▄]/.test(out)).toBe(false); // no half-block lion
    expect(out).toContain("█"); // the figlet wordmark is still there
  });

  it("uses a smaller lion on a narrow (but >=48) terminal than on a wide one", () => {
    const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
    const rows = (s: string) => strip(s).split("\n").filter((l) => /[▀▄█]/.test(l)).length;
    expect(rows(banner({ color: true, columns: 50 }))).toBeLessThan(
      rows(banner({ color: true, columns: 80 }))
    );
  });
});
