import { describe, it, expect } from "vitest";
import { parseDeviceCode } from "../src/engine/auth.js";

describe("parseDeviceCode", () => {
  it("extracts URL + code from a single line", () => {
    const line = "Please visit https://github.com/login/device and enter code WDJB-MJHT";
    expect(parseDeviceCode(line)).toEqual({
      verificationUri: "https://github.com/login/device",
      userCode: "WDJB-MJHT",
    });
  });

  it("extracts when URL and code arrive on separate lines (accumulated buffer)", () => {
    const buf = "First copy your one-time code: ABCD-1234\nThen open https://github.com/login/device\n";
    expect(parseDeviceCode(buf)).toEqual({
      verificationUri: "https://github.com/login/device",
      userCode: "ABCD-1234",
    });
  });

  it("returns undefined until both parts are present", () => {
    expect(parseDeviceCode("Starting device login...")).toBeUndefined();
    expect(parseDeviceCode("code: ABCD-1234 (no url yet)")).toBeUndefined();
  });
});
