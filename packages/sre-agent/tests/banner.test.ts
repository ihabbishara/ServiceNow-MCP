import { describe, it, expect, vi } from "vitest";
import { banner, supportsColor, printBanner } from "../src/banner.js";

const ORANGE = "\x1b[38;2;255;98;0m";
const CYAN = "\x1b[36m";
const hasLion = (s: string) => /[▀▄]/.test(s); // half-block glyphs are unique to the lion

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
  it("shows the lion above a two-tone ING SRE AGENT wordmark when color + width allow", () => {
    const out = banner({ color: true, columns: 80 });
    expect(hasLion(out)).toBe(true);
    expect(out).toContain(ORANGE); // ING + lion painted orange
    expect(out).toContain(CYAN); // SRE AGENT painted cyan
    expect(out).toContain("█"); // big figlet letters
    expect(out).toMatch(/ServiceNow.*Azure DevOps/);
  });

  it("drops the lion on a narrow terminal but keeps the big wordmark", () => {
    const out = banner({ color: true, columns: 60 });
    expect(hasLion(out)).toBe(false); // no room for the lion
    expect(out).toContain("█"); // wordmark still there
    expect(out).toContain(ORANGE);
  });

  it("falls back to plain text (no lion, no escapes) when color is off", () => {
    const out = banner({ color: false, columns: 120 });
    expect(out).not.toContain("\x1b[");
    expect(hasLion(out)).toBe(false);
    expect(out).toContain("█");
    expect(out).toMatch(/ServiceNow.*Azure DevOps/);
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
