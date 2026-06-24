import { describe, it, expect, vi } from "vitest";
import { RobotsClient } from "../src/clients/crawler/robotsClient.js";

describe("RobotsClient", () => {
  it("enforces robots.txt disallow rules when enabled", async () => {
    const fetcher = { getText: vi.fn(async () => "User-agent: *\nDisallow: /private\n") };
    const rc = new RobotsClient(fetcher, true);
    expect(await rc.fetchAndCheck("https://h/private/x")).toBe(false);
    expect(await rc.fetchAndCheck("https://h/ok")).toBe(true);
  });

  it("allows everything when disabled", async () => {
    const fetcher = { getText: vi.fn(async () => "User-agent: *\nDisallow: /private\n") };
    const rc = new RobotsClient(fetcher, false);
    expect(await rc.fetchAndCheck("https://h/private/x")).toBe(true);
    // Never fetches robots.txt when disabled.
    expect(fetcher.getText).not.toHaveBeenCalled();
  });

  it("fetches robots.txt once per origin (cached)", async () => {
    const fetcher = { getText: vi.fn(async () => "User-agent: *\nDisallow: /private\n") };
    const rc = new RobotsClient(fetcher, true);
    await rc.fetchAndCheck("https://h/private/x");
    await rc.fetchAndCheck("https://h/ok");
    await rc.fetchAndCheck("https://h/other");
    expect(fetcher.getText).toHaveBeenCalledTimes(1);
    expect(fetcher.getText).toHaveBeenCalledWith("https://h/robots.txt");
  });

  it("allows when the URL is unparseable", async () => {
    const fetcher = { getText: vi.fn(async () => "User-agent: *\nDisallow: /\n") };
    const rc = new RobotsClient(fetcher, true);
    expect(await rc.fetchAndCheck("not a url")).toBe(true);
    expect(fetcher.getText).not.toHaveBeenCalled();
  });
});
