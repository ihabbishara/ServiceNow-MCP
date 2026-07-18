import { describe, it, expect, vi } from "vitest";
import { SharePointService } from "./index.js";
import type { SharePointConfig, Parsers } from "../../clients/sharepoint/types.js";

const cfg: SharePointConfig = {
  enabled: true,
  siteUrl: "https://acme.sharepoint.com/sites/SRE",
  incidentRoot: "",
  docsSubfolder: "Docs",
  authMode: "azcli",
  azPath: "az",
  maxDocTokens: 1000,
  maxFiles: 50,
  maxFileBytes: 1_000_000,
  timeoutMs: 30000
};

const folder = (name: string, id: string) => ({ id, name, folder: {} });
const file = (name: string, id: string, size = 10) => ({
  id,
  name,
  file: {},
  size,
  webUrl: `http://x/${name}`
});

// Fake GraphPort: site/drive via get(), children via getAllPages(), bytes via download().
const makeGraph = (children: Record<string, any[]>, bytes: Record<string, Buffer>) => ({
  get: vi.fn(async (p: string) => (p.endsWith("/drive") ? { id: "drive1" } : { id: "site1" })),
  getAllPages: vi.fn(async (p: string) => children[p] ?? []),
  download: vi.fn(async (_d: string, itemId: string) => bytes[itemId] ?? Buffer.from(""))
});

const parsers: Parsers = {
  docx: async (b) => b.toString(),
  xlsx: async (b) => b.toString(),
  pptx: async (b) => b.toString(),
  pdf: async (b) => b.toString(),
  csv: async (b) => b.toString(),
  txt: async (b) => b.toString(),
  md: async (b) => b.toString()
};

describe("SharePointService.getIncidentDocuments", () => {
  it("locates, walks, extracts, and returns documents", async () => {
    const graph = makeGraph(
      {
        "/drives/drive1/root/children": [folder("INC123456 iDeal", "incF")],
        "/drives/drive1/items/incF/children": [folder("Docs", "docs")],
        "/drives/drive1/items/docs/children": [file("a.docx", "a")]
      },
      { a: Buffer.from("hello") }
    );
    const svc = new SharePointService(cfg, graph as any, parsers);
    const out = await svc.getIncidentDocuments("INC123456");
    expect(out.incident).toBe("INC123456");
    expect(out.folder.name).toBe("INC123456 iDeal");
    expect(out.count).toBe(1);
    expect(out.documents[0]).toMatchObject({
      name: "a.docx",
      format: "docx",
      text: "hello",
      truncated: false
    });
  });

  it("throws a clear error when the folder is not found", async () => {
    const graph = makeGraph({ "/drives/drive1/root/children": [] }, {});
    const svc = new SharePointService(cfg, graph as any, parsers);
    await expect(svc.getIncidentDocuments("INC000000")).rejects.toThrow(
      "No SharePoint folder found for INC000000"
    );
  });

  it("truncates to the token budget and counts truncations", async () => {
    const big = Buffer.from("x".repeat(8000)); // ~2000 tokens, budget is 1000
    const graph = makeGraph(
      {
        "/drives/drive1/root/children": [folder("INC1 a", "incF")],
        "/drives/drive1/items/incF/children": [folder("Docs", "docs")],
        "/drives/drive1/items/docs/children": [file("big.docx", "big")]
      },
      { big }
    );
    const svc = new SharePointService(cfg, graph as any, parsers);
    const out = await svc.getIncidentDocuments("INC1");
    expect(out.documents[0].truncated).toBe(true);
    expect(out.documents[0].text.length).toBe(1000 * 4); // budget tokens * 4 chars
    expect(out.truncatedCount).toBe(1);
  });

  it("records skips for oversized and unsupported files", async () => {
    const graph = makeGraph(
      {
        "/drives/drive1/root/children": [folder("INC1 a", "incF")],
        "/drives/drive1/items/incF/children": [folder("Docs", "docs")],
        "/drives/drive1/items/docs/children": [
          file("huge.docx", "huge", 5_000_000),
          file("notes.one", "n")
        ]
      },
      {}
    );
    const svc = new SharePointService(cfg, graph as any, parsers);
    const out = await svc.getIncidentDocuments("INC1");
    expect(out.count).toBe(0);
    expect(out.skipped).toEqual([
      { name: "huge.docx", reason: "exceeds max file bytes (5000000 > 1000000)" },
      { name: "notes.one", reason: "unsupported format: .one" }
    ]);
  });

  it("records a download-throw as a skip and continues processing", async () => {
    // "failing.docx" will throw on download; "ok.docx" should still be processed
    const baseGraph = makeGraph(
      {
        "/drives/drive1/root/children": [folder("INC1 a", "incF")],
        "/drives/drive1/items/incF/children": [folder("Docs", "docs")],
        "/drives/drive1/items/docs/children": [file("failing.docx", "fail"), file("ok.docx", "ok")]
      },
      { ok: Buffer.from("good content") }
    );
    // Override download to throw for the "fail" itemId
    const graph = {
      ...baseGraph,
      download: vi.fn(async (_d: string, itemId: string, _max?: number) => {
        if (itemId === "fail") throw new Error("download exceeds max bytes (999999 > 1000000)");
        return Buffer.from("good content");
      })
    };
    const svc = new SharePointService(cfg, graph as any, parsers);
    const out = await svc.getIncidentDocuments("INC1");
    expect(out.count).toBe(1);
    expect(out.documents[0].name).toBe("ok.docx");
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0].name).toBe("failing.docx");
    expect(out.skipped[0].reason).toMatch(/exceeds max bytes/);
  });

  it("second doc gets empty text and truncated=true when first fills budget", async () => {
    // Budget: 1000 tokens = 4000 chars
    // first.docx returns 8000 chars → truncated to 4000, exhausts budget
    // second.docx returns non-empty text → remainingChars = 0, text = "", truncated = true
    const firstText = "x".repeat(8000);
    const secondText = "y".repeat(100);
    const graph = makeGraph(
      {
        "/drives/drive1/root/children": [folder("INC1 a", "incF")],
        "/drives/drive1/items/incF/children": [folder("Docs", "docs")],
        "/drives/drive1/items/docs/children": [
          file("first.docx", "first"),
          file("second.docx", "second")
        ]
      },
      {
        first: Buffer.from(firstText),
        second: Buffer.from(secondText)
      }
    );
    const svc = new SharePointService(cfg, graph as any, parsers);
    const out = await svc.getIncidentDocuments("INC1");
    expect(out.count).toBe(2);
    expect(out.documents[0].truncated).toBe(true);
    expect(out.documents[0].text.length).toBe(4000);
    expect(out.documents[1].text).toBe("");
    expect(out.documents[1].truncated).toBe(true);
    expect(out.truncatedCount).toBe(2);
  });
});
