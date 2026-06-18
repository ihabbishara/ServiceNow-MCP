import { describe, it, expect, vi } from "vitest";
import { banner, supportsColor, printBanner } from "../src/banner.js";

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

describe("banner", () => {
  it("contains the block art and the tagline", () => {
    const out = banner({ color: false });
    expect(out).toContain("█"); // block glyphs present
    expect(out).toMatch(/ServiceNow.*Azure DevOps/);
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
