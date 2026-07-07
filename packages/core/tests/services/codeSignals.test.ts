import { describe, it, expect } from "vitest";
import { detectCodeSignals } from "../../src/services/codeSignals.js";

describe("detectCodeSignals positives", () => {
  it("detects a Node stack frame", () => {
    const r = detectCodeSignals(["at charge (src/payments/charge.ts:42:11)"]);
    expect(r.detected).toBe(true);
    expect(r.signals[0]).toContain("charge.ts:42");
  });

  it("detects a bare file:line with a code extension", () => {
    const r = detectCodeSignals(["failure in OrderService.java:118 during checkout"]);
    expect(r.detected).toBe(true);
    expect(r.signals[0]).toContain("OrderService.java:118");
  });

  it("detects exception class names", () => {
    expect(detectCodeSignals(["NullPointerException: order was null"]).detected).toBe(true);
    expect(detectCodeSignals(["TypeError: Cannot read properties of undefined"]).detected).toBe(
      true
    );
  });

  it("detects a Python traceback", () => {
    expect(
      detectCodeSignals(["Traceback (most recent call last):", '  File "app.py"']).detected
    ).toBe(true);
  });

  it("finds signals across multiple fields (worknotes + description)", () => {
    const r = detectCodeSignals(["users cannot pay", "logs show: at pay (billing.py:9)"]);
    expect(r.detected).toBe(true);
  });
});

describe("detectCodeSignals negatives", () => {
  it("ignores plain prose, URLs, IP:port, semver, timestamps", () => {
    const r = detectCodeSignals([
      "Users report the checkout page is slow since 12:30:45.",
      "Service at https://pay.example.com/v2 returns 502.",
      "Upstream 10.0.0.1:443 unreachable. Deployed v1.2.3 yesterday."
    ]);
    expect(r).toEqual({ detected: false, signals: [] });
  });

  it("ignores bare 'Error:' / 'Exception:' without a class-name prefix", () => {
    expect(detectCodeSignals(["Error: timeout connecting to db"]).detected).toBe(false);
    expect(detectCodeSignals(["Exception: something broke"]).detected).toBe(false);
  });

  it("handles empty and undefined inputs", () => {
    expect(detectCodeSignals([])).toEqual({ detected: false, signals: [] });
    expect(detectCodeSignals([undefined, "", undefined])).toEqual({ detected: false, signals: [] });
  });
});

describe("detectCodeSignals caps", () => {
  it("caps at 3 distinct signals", () => {
    const r = detectCodeSignals(["a.ts:1 b.ts:2 c.ts:3 d.ts:4 e.ts:5"]);
    expect(r.signals).toHaveLength(3);
    expect(r.detected).toBe(true);
  });

  it("dedupes identical snippets and flattens whitespace", () => {
    const r = detectCodeSignals(["at f (x.ts:1)\nat f (x.ts:1)"]);
    expect(r.signals).toHaveLength(1);
    expect(r.signals[0]).not.toContain("\n");
  });

  it("truncates snippets to 120 chars", () => {
    const long = "at " + "x".repeat(150) + " (deep/path/file.ts:12)";
    const r = detectCodeSignals([long]);
    expect(r.signals[0].length).toBeLessThanOrEqual(120);
  });
});
