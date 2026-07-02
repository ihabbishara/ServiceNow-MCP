import { describe, it, expect, vi } from "vitest";
import { walkDocs } from "./walk.js";

const folder = (name: string, id: string) => ({ id, name, folder: {} });
const file = (name: string, id: string, size = 10) => ({
  id,
  name,
  file: {},
  size,
  webUrl: `http://x/${name}`
});

// A fake GraphPort whose getAllPages returns canned children keyed by path.
const fakeGraph = (byPath: Record<string, any[]>) => ({
  get: vi.fn(),
  download: vi.fn(),
  getAllPages: vi.fn(async (path: string) => byPath[path] ?? [])
});

describe("walkDocs", () => {
  it("recurses Docs and yields files with paths, bounded by maxFiles", async () => {
    const graph = fakeGraph({
      "/drives/d/items/incF/children": [folder("Docs", "docs"), folder("IncidentNoteBook", "nb")],
      "/drives/d/items/docs/children": [file("a.docx", "a"), folder("sub", "sub")],
      "/drives/d/items/sub/children": [file("b.pdf", "b"), file("c.xlsx", "c")]
    });
    const files = [];
    for await (const f of walkDocs(graph as any, "d", "incF", "Docs", { maxFiles: 50 }))
      files.push(f);
    expect(files.map((f) => f.path)).toEqual(["Docs/a.docx", "Docs/sub/b.pdf", "Docs/sub/c.xlsx"]);
    expect(graph.getAllPages).not.toHaveBeenCalledWith("/drives/d/items/nb/children"); // IncidentNoteBook ignored
  });

  it("yields nothing when there is no Docs subfolder", async () => {
    const graph = fakeGraph({ "/drives/d/items/incF/children": [folder("Other", "o")] });
    const files = [];
    for await (const f of walkDocs(graph as any, "d", "incF", "Docs", { maxFiles: 50 }))
      files.push(f);
    expect(files).toEqual([]);
  });

  it("stops at maxFiles", async () => {
    const graph = fakeGraph({
      "/drives/d/items/incF/children": [folder("Docs", "docs")],
      "/drives/d/items/docs/children": [file("a", "a"), file("b", "b"), file("c", "c")]
    });
    const files = [];
    for await (const f of walkDocs(graph as any, "d", "incF", "Docs", { maxFiles: 2 }))
      files.push(f);
    expect(files.length).toBe(2);
  });
});
