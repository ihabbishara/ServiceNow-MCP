import { describe, it, expect, vi } from "vitest";
import { GraphTokenProvider } from "./token.js";

const azReturning = (token: string, expiresOnIso: string) => ({
  json: vi.fn().mockResolvedValue({ accessToken: token, expiresOn: expiresOnIso })
});

describe("GraphTokenProvider", () => {
  it("acquires a token via az and caches within TTL", async () => {
    const az = azReturning("tok-1", "2999-01-01 00:00:00.000000");
    let now = 1_000_000;
    const p = new GraphTokenProvider({ az: az as any, now: () => now });
    expect(await p.getToken()).toBe("tok-1");
    now += 60_000;
    expect(await p.getToken()).toBe("tok-1");
    expect(az.json).toHaveBeenCalledTimes(1);
    expect(az.json).toHaveBeenCalledWith([
      "account", "get-access-token", "--resource", "https://graph.microsoft.com"
    ]);
  });

  it("refreshes after expiry", async () => {
    const az = {
      json: vi
        .fn()
        .mockResolvedValueOnce({ accessToken: "tok-1", expiresOn: "2999-01-01 00:00:00.000000", expires_on: 2000 })
        .mockResolvedValueOnce({ accessToken: "tok-2", expiresOn: "2999-01-01 00:00:00.000000", expires_on: 9_999_999_999 })
    };
    let now = 1_000_000; // ms
    const p = new GraphTokenProvider({ az: az as any, now: () => now });
    expect(await p.getToken()).toBe("tok-1"); // expires_on 2000s → 2_000_000ms, minus skew
    now = 2_500_000;
    expect(await p.getToken()).toBe("tok-2");
    expect(az.json).toHaveBeenCalledTimes(2);
  });
});
