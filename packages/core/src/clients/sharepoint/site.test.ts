import { describe, it, expect, vi } from "vitest";
import { resolveSite } from "./site.js";

describe("resolveSite", () => {
  it("resolves site id then default drive id from a site URL", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ id: "acme.sharepoint.com,guid1,guid2" })
      .mockResolvedValueOnce({ id: "drive-99" });
    const graph = { get, getAllPages: vi.fn(), download: vi.fn() };
    const out = await resolveSite(graph as any, "https://acme.sharepoint.com/sites/SRE");
    expect(out).toEqual({ siteId: "acme.sharepoint.com,guid1,guid2", driveId: "drive-99" });
    expect(get).toHaveBeenNthCalledWith(1, "/sites/acme.sharepoint.com:/sites/SRE");
    expect(get).toHaveBeenNthCalledWith(2, "/sites/acme.sharepoint.com,guid1,guid2/drive");
  });
});
