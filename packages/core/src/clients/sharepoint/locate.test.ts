import { describe, it, expect, vi } from "vitest";
import { findIncidentFolder } from "./locate.js";

const folder = (name: string, id: string) => ({ id, name, folder: {} });
const file = (name: string, id: string) => ({ id, name, file: {} });

describe("findIncidentFolder", () => {
  it("matches a folder whose name starts with the incident number (case-insensitive)", async () => {
    const getAllPages = vi.fn().mockResolvedValue([
      file("INC123456 notes.txt", "f0"),
      folder("INC123456 iDeal", "f1"),
      folder("INC999999 Other", "f2")
    ]);
    const graph = { get: vi.fn(), getAllPages, download: vi.fn() };
    const out = await findIncidentFolder(graph as any, "drive1", "", "inc123456");
    expect(out).toEqual({ id: "f1", name: "INC123456 iDeal", webUrl: undefined });
    expect(getAllPages).toHaveBeenCalledWith("/drives/drive1/root/children");
  });

  it("uses the incidentRoot path when provided", async () => {
    const getAllPages = vi.fn().mockResolvedValue([folder("INC123456 X", "f1")]);
    const graph = { get: vi.fn(), getAllPages, download: vi.fn() };
    await findIncidentFolder(graph as any, "drive1", "Incidents/2026", "INC123456");
    expect(getAllPages).toHaveBeenCalledWith("/drives/drive1/root:/Incidents%2F2026:/children");
  });

  it("returns null when no folder matches", async () => {
    const graph = { get: vi.fn(), getAllPages: vi.fn().mockResolvedValue([file("x.docx", "f0")]), download: vi.fn() };
    expect(await findIncidentFolder(graph as any, "drive1", "", "INC123456")).toBeNull();
  });
});
