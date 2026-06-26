# SharePoint Incident-Docs Retrieval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a chat references an incident number, fetch that incident's documents from a SharePoint Online library, extract their text (docx/xlsx/pptx/pdf), and return it for the model to read and cite.

**Architecture:** A read-only Microsoft Graph integration in `@sre/core`, authenticated with a *delegated* `az` CLI token (no new PAT/secret). A `GraphClient` (token + paginated HTTP + download) underpins four pure helpers (resolve site → locate INC folder by `startswith` → recurse `Docs` subtree → extract per format), orchestrated by a `SharePointService` that assembles text under a token budget. One tool, `get_incident_documents`, is projected into both the `sre-agent` (Copilot SDK) and `mcp-server` surfaces, gated on `SHAREPOINT_ENABLED`.

**Tech Stack:** TypeScript (ESM), undici (`fetch` + `ProxyAgent`), Zod (config), Vitest (tests), `mammoth` (docx), `xlsx`/SheetJS (xlsx), `officeparser` (pptx), `pdf-parse` (pdf). Reuses existing `AzRunner` (`clients/ado/az.ts`) for the token.

**Reference spec:** `docs/superpowers/specs/2026-06-26-sharepoint-incident-docs-design.md`

---

## File Structure

**New (in `packages/core/src`):**
- `clients/sharepoint/types.ts` — config + Graph + result types (no logic).
- `clients/sharepoint/token.ts` — `GraphTokenProvider`: az token, cached to expiry.
- `clients/sharepoint/graph.ts` — `GraphClient` (implements `GraphPort`): paginated GET, download, 429/Retry-After, proxy.
- `clients/sharepoint/site.ts` — `resolveSite()`: site URL → `{ siteId, driveId }`.
- `clients/sharepoint/locate.ts` — `findIncidentFolder()`: base-folder children → `startswith` match.
- `clients/sharepoint/walk.ts` — `walkDocs()`: recurse the `Docs` subtree, yield files.
- `clients/sharepoint/extract.ts` — `extractText()`: dispatch bytes → text by format.
- `clients/sharepoint/parsers.ts` — `defaultParsers`: the real lib calls (thin; integration-tested).
- `services/sharepoint/index.ts` — `SharePointService` + `createSharePointService()`.

**New (in `packages/mcp-server/src`):**
- `tools/sharepoint.ts` — `registerSharePointTools()`.

**Modified:**
- `packages/core/src/config.ts` — `SharePointConfig`, env, validation, `AppConfig.sharePoint`.
- `packages/core/src/runtime.ts` — wire `runtime.sharePoint` (only when enabled).
- `packages/core/src/index.ts` — export `SharePointService` + types if needed.
- `packages/mcp-server/src/server.ts` — call `registerSharePointTools`.
- `packages/sre-agent/src/tools/index.ts` — add `get_incident_documents`.
- `packages/sre-agent/src/config.ts` — `sharePointEnabled` flag on `AgentConfig`.
- `packages/sre-agent/src/engine/engine.ts` — combine knowledge + SharePoint system nudges.
- `packages/sre-agent/src/workflows/index.ts` — add a fetch step to incident workflows.
- `packages/sre-agent/src/doctor.ts` — SharePoint preflight.
- `packages/sre-agent/.env.example`, `README.md`, `packages/sre-agent/README.md` — docs.

**Shared type contract (defined in Task 2, referenced everywhere):**

```ts
// clients/sharepoint/types.ts
export interface SharePointConfig {
  enabled: boolean;
  siteUrl: string;          // https://acme.sharepoint.com/sites/SRE
  incidentRoot: string;     // "" = drive root; else server-relative folder path
  docsSubfolder: string;    // "Docs"
  authMode: "azcli";
  azPath: string;           // "az"
  proxyUrl?: string;
  maxDocTokens: number;     // 50000
  maxFiles: number;         // 50
  maxFileBytes: number;     // 10485760
  timeoutMs: number;        // 30000
}

export interface GraphDriveItem {
  id: string;
  name: string;
  webUrl?: string;
  size?: number;
  folder?: { childCount?: number };
  file?: { mimeType?: string };
}

export interface DriveItemRef { id: string; name: string; webUrl?: string; }

export interface DriveFile {
  id: string;
  name: string;
  webUrl?: string;
  size: number;
  path: string;             // e.g. "Docs/sub/runbook.docx"
}

export type ExtractResult = { text: string } | { skipped: string };

export type DocFormat = "docx" | "xlsx" | "pptx" | "pdf";

export interface IncidentDocument {
  name: string;
  path: string;
  webUrl?: string;
  format: DocFormat;
  bytes: number;
  textChars: number;
  truncated: boolean;
  text: string;
}

export interface IncidentDocsResult {
  incident: string;
  folder: { name: string; webUrl?: string };
  count: number;
  documents: IncidentDocument[];
  totalChars: number;
  truncatedCount: number;
  skipped: { name: string; reason: string }[];
}

// The seam the service depends on; GraphClient implements it, tests fake it.
export interface GraphPort {
  get<T>(path: string): Promise<T>;
  getAllPages<T>(path: string): Promise<T[]>;
  download(driveId: string, itemId: string): Promise<Buffer>;
}

export interface Parsers {
  docx: (b: Buffer) => Promise<string>;
  xlsx: (b: Buffer) => Promise<string>;
  pptx: (b: Buffer) => Promise<string>;
  pdf: (b: Buffer) => Promise<string>;
}
```

---

## Task 1: Install parser dependencies

**Files:**
- Modify: `packages/core/package.json`

- [ ] **Step 1: Add deps**

Run (from repo root):
```bash
npm --workspace @sre/core install mammoth xlsx officeparser pdf-parse@1.1.1
npm --workspace @sre/core install -D @types/pdf-parse
```
Expected: `package.json` dependencies updated, `package-lock.json` changed, no build run yet.

> **pdf-parse is pinned to `1.1.1` deliberately.** The unpinned `pdf-parse@2.x` is an
> ESM rewrite with a different (class-based) API and no `./lib/pdf-parse.js` subpath.
> v1.1.1 keeps the simple `pdf(buffer) => { text }` signature used in Task 9 and the
> `pdf-parse/lib/pdf-parse.js` inner-path import (which sidesteps v1's debug top-level
> file read). `@types/pdf-parse@1.1.x` matches it.

- [ ] **Step 2: Verify they import under ESM**

Run:
```bash
node --input-type=module -e "import('mammoth').then(()=>import('xlsx')).then(()=>import('officeparser')).then(()=>import('pdf-parse/lib/pdf-parse.js')).then(()=>console.log('ok'))"
```
Expected: prints `ok` (note: `pdf-parse` is imported via its inner path `pdf-parse/lib/pdf-parse.js` to avoid the package's debug-mode top-level file read).

- [ ] **Step 3: Commit**

```bash
git add packages/core/package.json package-lock.json
git commit -m "build(core): add docx/xlsx/pptx/pdf text-extraction deps"
```

---

## Task 2: Shared types

**Files:**
- Create: `packages/core/src/clients/sharepoint/types.ts`

- [ ] **Step 1: Create the types file**

Paste the entire "Shared type contract" block above into `packages/core/src/clients/sharepoint/types.ts`.

- [ ] **Step 2: Verify it compiles**

Run: `npm --workspace @sre/core run build`
Expected: PASS (types-only file, no errors).

- [ ] **Step 3: Commit**

```bash
git add packages/core/src/clients/sharepoint/types.ts
git commit -m "feat(core): SharePoint integration types"
```

---

## Task 3: Config — SharePoint env + validation

**Files:**
- Modify: `packages/core/src/config.ts`
- Test: `packages/core/src/config.test.ts` (append cases; create if absent)

- [ ] **Step 1: Write failing tests**

Add to `packages/core/src/config.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { loadConfig } from "./config.js";

const base = {
  SERVICENOW_BASE_URL: "https://sn.example.com",
  SERVICENOW_USERNAME: "u",
  SERVICENOW_PASSWORD: "p"
};

describe("sharePoint config", () => {
  it("defaults to disabled with no env", () => {
    const cfg = loadConfig(base);
    expect(cfg.sharePoint.enabled).toBe(false);
  });

  it("requires SHAREPOINT_SITE_URL when enabled", () => {
    expect(() => loadConfig({ ...base, SHAREPOINT_ENABLED: "true" })).toThrow(
      /SHAREPOINT_ENABLED=true requires SHAREPOINT_SITE_URL/
    );
  });

  it("parses enabled config with defaults", () => {
    const cfg = loadConfig({
      ...base,
      SHAREPOINT_ENABLED: "true",
      SHAREPOINT_SITE_URL: "https://acme.sharepoint.com/sites/SRE"
    });
    expect(cfg.sharePoint).toMatchObject({
      enabled: true,
      siteUrl: "https://acme.sharepoint.com/sites/SRE",
      incidentRoot: "",
      docsSubfolder: "Docs",
      authMode: "azcli",
      maxDocTokens: 50000,
      maxFiles: 50,
      maxFileBytes: 10485760,
      timeoutMs: 30000
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --workspace @sre/core run test -- config.test`
Expected: FAIL (`cfg.sharePoint` is undefined).

- [ ] **Step 3: Add env schema fields**

In `packages/core/src/config.ts`, inside `envSchema = z.object({ ... })`, after the `AZURE_API_VERSION` line, add:
```ts
  SHAREPOINT_ENABLED: boolString,
  SHAREPOINT_SITE_URL: optional(z.string().url()),
  SHAREPOINT_INCIDENT_ROOT: z.string().optional().transform((v) => (v ?? "").replace(/^\/+|\/+$/g, "")),
  SHAREPOINT_DOCS_SUBFOLDER: z.string().default("Docs"),
  SHAREPOINT_PROXY: optionalUrl,
  SHAREPOINT_MAX_DOC_TOKENS: z.coerce.number().int().positive().default(50000),
  SHAREPOINT_MAX_FILES: z.coerce.number().int().positive().default(50),
  SHAREPOINT_MAX_FILE_BYTES: z.coerce.number().int().positive().default(10485760),
  SHAREPOINT_TIMEOUT_MS: z.coerce.number().int().positive().default(30000)
```
(`boolString`, `optional`, `optionalUrl` already exist at the top of the file. `AZ_PATH` already exists for ADO and is reused.)

- [ ] **Step 4: Add the `SharePointConfig` interface and `AppConfig` field**

After the `KnowledgeConfig` interface, add:
```ts
export interface SharePointConfig {
  enabled: boolean;
  siteUrl: string;
  incidentRoot: string;
  docsSubfolder: string;
  authMode: "azcli";
  azPath: string;
  proxyUrl?: string;
  maxDocTokens: number;
  maxFiles: number;
  maxFileBytes: number;
  timeoutMs: number;
}
```
In the `AppConfig` interface add a field: `sharePoint: SharePointConfig;`

- [ ] **Step 5: Build + return the config**

In `loadConfig`, after the `ADO_ENABLED` validation block, add:
```ts
  if (e.SHAREPOINT_ENABLED && !e.SHAREPOINT_SITE_URL) {
    throw new Error("SHAREPOINT_ENABLED=true requires SHAREPOINT_SITE_URL");
  }
```
In the returned object (sibling of `knowledge`, `azureDevOps`) add:
```ts
    sharePoint: {
      enabled: e.SHAREPOINT_ENABLED,
      siteUrl: e.SHAREPOINT_SITE_URL?.replace(/\/+$/, "") ?? "",
      incidentRoot: e.SHAREPOINT_INCIDENT_ROOT,
      docsSubfolder: e.SHAREPOINT_DOCS_SUBFOLDER,
      authMode: "azcli",
      azPath: e.AZ_PATH,
      proxyUrl: e.SHAREPOINT_PROXY,
      maxDocTokens: e.SHAREPOINT_MAX_DOC_TOKENS,
      maxFiles: e.SHAREPOINT_MAX_FILES,
      maxFileBytes: e.SHAREPOINT_MAX_FILE_BYTES,
      timeoutMs: e.SHAREPOINT_TIMEOUT_MS
    },
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm --workspace @sre/core run test -- config.test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/config.ts packages/core/src/config.test.ts
git commit -m "feat(core): SharePoint config env + validation"
```

---

## Task 4: GraphTokenProvider

**Files:**
- Create: `packages/core/src/clients/sharepoint/token.ts`
- Test: `packages/core/src/clients/sharepoint/token.test.ts`

- [ ] **Step 1: Write failing test**

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --workspace @sre/core run test -- token.test`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// packages/core/src/clients/sharepoint/token.ts
import type { AzRunner } from "../ado/az.js";

interface AzToken {
  accessToken: string;
  expiresOn?: string;   // local time "YYYY-MM-DD HH:MM:SS.ffffff"
  expires_on?: number;  // unix seconds (newer az)
}

const GRAPH_RESOURCE = "https://graph.microsoft.com";

/** Delegated Microsoft Graph token from the Azure CLI, cached until just before expiry. */
export class GraphTokenProvider {
  private cached?: { token: string; expiresAtMs: number };
  private readonly az: AzRunner;
  private readonly now: () => number;
  private readonly skewMs: number;
  private readonly resource: string;

  constructor(opts: { az: AzRunner; now?: () => number; skewMs?: number; resource?: string }) {
    this.az = opts.az;
    this.now = opts.now ?? Date.now;
    this.skewMs = opts.skewMs ?? 120_000;
    this.resource = opts.resource ?? GRAPH_RESOURCE;
  }

  async getToken(): Promise<string> {
    if (this.cached && this.now() < this.cached.expiresAtMs - this.skewMs) {
      return this.cached.token;
    }
    const t = await this.az.json<AzToken>([
      "account", "get-access-token", "--resource", this.resource
    ]);
    if (!t?.accessToken) throw new Error("az returned no accessToken for Microsoft Graph");
    const expiresAtMs =
      typeof t.expires_on === "number"
        ? t.expires_on * 1000
        : t.expiresOn
          ? Date.parse(t.expiresOn.replace(" ", "T"))
          : this.now() + 3_600_000;
    this.cached = { token: t.accessToken, expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : this.now() + 3_600_000 };
    return this.cached.token;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm --workspace @sre/core run test -- token.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/clients/sharepoint/token.ts packages/core/src/clients/sharepoint/token.test.ts
git commit -m "feat(core): delegated Graph token provider via az CLI"
```

---

## Task 5: GraphClient (paginated HTTP + download + 429)

**Files:**
- Create: `packages/core/src/clients/sharepoint/graph.ts`
- Test: `packages/core/src/clients/sharepoint/graph.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect, vi } from "vitest";
import { GraphClient } from "./graph.js";

const res = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  json: async () => body,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  arrayBuffer: async () => (body as Buffer)
});

const client = (fetchImpl: any) =>
  new GraphClient({ getToken: async () => "tok", fetchImpl, timeoutMs: 1000 });

describe("GraphClient", () => {
  it("GETs with bearer auth and returns json", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(200, { id: "s1" }));
    const out = await client(fetchImpl).get<{ id: string }>("/sites/x");
    expect(out.id).toBe("s1");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://graph.microsoft.com/v1.0/sites/x");
    expect(init.headers.Authorization).toBe("Bearer tok");
  });

  it("getAllPages follows @odata.nextLink and flattens value", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(res(200, { value: [{ id: "a" }], "@odata.nextLink": "https://graph.microsoft.com/v1.0/next" }))
      .mockResolvedValueOnce(res(200, { value: [{ id: "b" }] }));
    const out = await client(fetchImpl).getAllPages<{ id: string }>("/drives/d/root/children");
    expect(out.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("retries on 429 honoring Retry-After", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(res(429, "slow down", { "retry-after": "0" }))
      .mockResolvedValueOnce(res(200, { id: "ok" }));
    const out = await client(fetchImpl).get<{ id: string }>("/x");
    expect(out.id).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("throws with status + snippet on non-retryable error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(res(404, "not found"));
    await expect(client(fetchImpl).get("/missing")).rejects.toThrow(/Graph GET \/missing failed: 404/);
  });

  it("download returns a Buffer of the item content", async () => {
    const bytes = Buffer.from("hello");
    const fetchImpl = vi.fn().mockResolvedValue({ ...res(200, ""), arrayBuffer: async () => bytes });
    const out = await client(fetchImpl).download("drive1", "item1");
    expect(Buffer.from(out).toString()).toBe("hello");
    expect(fetchImpl.mock.calls[0][0]).toBe("https://graph.microsoft.com/v1.0/drives/drive1/items/item1/content");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --workspace @sre/core run test -- graph.test`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// packages/core/src/clients/sharepoint/graph.ts
import { fetch } from "undici";
import { proxyDispatcher, FetchDispatcher } from "../proxy.js";
import type { GraphPort } from "./types.js";

const BASE = "https://graph.microsoft.com/v1.0";
const MAX_RETRIES = 4;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type FetchImpl = typeof fetch;

export interface GraphClientOptions {
  getToken: () => Promise<string>;
  proxyUrl?: string;
  timeoutMs?: number;
  fetchImpl?: FetchImpl;
}

/** Thin Microsoft Graph v1.0 client: bearer auth, pagination, 429 backoff, downloads. */
export class GraphClient implements GraphPort {
  private readonly getToken: () => Promise<string>;
  private readonly dispatcher?: FetchDispatcher;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchImpl;

  constructor(opts: GraphClientOptions) {
    this.getToken = opts.getToken;
    this.dispatcher = proxyDispatcher(opts.proxyUrl);
    this.timeoutMs = opts.timeoutMs ?? 30000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** absoluteOrPath: a path beginning "/" (joined to BASE) or a full nextLink URL. */
  private async request(absoluteOrPath: string, accept = "application/json"): Promise<any> {
    const url = absoluteOrPath.startsWith("http") ? absoluteOrPath : `${BASE}${absoluteOrPath}`;
    const label = absoluteOrPath.startsWith("http") ? new URL(absoluteOrPath).pathname : absoluteOrPath;
    for (let attempt = 0; ; attempt++) {
      const token = await this.getToken();
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.timeoutMs);
      let res: Awaited<ReturnType<FetchImpl>>;
      try {
        res = await this.fetchImpl(url, {
          headers: { Authorization: `Bearer ${token}`, Accept: accept },
          dispatcher: this.dispatcher,
          signal: ac.signal
        } as any);
      } finally {
        clearTimeout(timer);
      }
      if (res.status === 429 && attempt < MAX_RETRIES) {
        const retryAfter = Number(res.headers.get("retry-after") ?? "1");
        await sleep((Number.isFinite(retryAfter) ? retryAfter : 1) * 1000);
        continue;
      }
      if (!res.ok) {
        const body = (await res.text()).slice(0, 200);
        throw new Error(`Graph GET ${label} failed: ${res.status} ${body}`);
      }
      return res;
    }
  }

  async get<T>(path: string): Promise<T> {
    const res = await this.request(path);
    return (await res.json()) as T;
  }

  async getAllPages<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    let next: string | undefined = path;
    while (next) {
      const page = (await (await this.request(next)).json()) as { value: T[]; "@odata.nextLink"?: string };
      out.push(...(page.value ?? []));
      next = page["@odata.nextLink"];
    }
    return out;
  }

  async download(driveId: string, itemId: string): Promise<Buffer> {
    const res = await this.request(`/drives/${driveId}/items/${itemId}/content`, "application/octet-stream");
    return Buffer.from(await res.arrayBuffer());
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm --workspace @sre/core run test -- graph.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/clients/sharepoint/graph.ts packages/core/src/clients/sharepoint/graph.test.ts
git commit -m "feat(core): Graph HTTP client with pagination, 429 backoff, downloads"
```

---

## Task 6: resolveSite

**Files:**
- Create: `packages/core/src/clients/sharepoint/site.ts`
- Test: `packages/core/src/clients/sharepoint/site.test.ts`

- [ ] **Step 1: Write failing test**

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --workspace @sre/core run test -- site.test`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// packages/core/src/clients/sharepoint/site.ts
import type { GraphPort } from "./types.js";

/** Resolve a SharePoint site URL to its Graph siteId and default document-library driveId. */
export const resolveSite = async (
  graph: GraphPort,
  siteUrl: string
): Promise<{ siteId: string; driveId: string }> => {
  const u = new URL(siteUrl);
  const serverRelative = u.pathname.replace(/\/+$/, ""); // e.g. "/sites/SRE"
  const site = await graph.get<{ id: string }>(`/sites/${u.hostname}:${serverRelative}`);
  const drive = await graph.get<{ id: string }>(`/sites/${site.id}/drive`);
  return { siteId: site.id, driveId: drive.id };
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm --workspace @sre/core run test -- site.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/clients/sharepoint/site.ts packages/core/src/clients/sharepoint/site.test.ts
git commit -m "feat(core): resolve SharePoint site URL to siteId + driveId"
```

---

## Task 7: findIncidentFolder (startswith locate)

**Files:**
- Create: `packages/core/src/clients/sharepoint/locate.ts`
- Test: `packages/core/src/clients/sharepoint/locate.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
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
```

Note the expected encoding: `Incidents/2026` → `Incidents%2F2026` (the helper encodes each path segment but joins with `%2F` so the whole thing sits inside the Graph `root:/<path>:` addressing).

- [ ] **Step 2: Run to verify it fails**

Run: `npm --workspace @sre/core run test -- locate.test`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// packages/core/src/clients/sharepoint/locate.ts
import type { GraphPort, GraphDriveItem, DriveItemRef } from "./types.js";

/** Encode a server-relative folder path for Graph `root:/<path>:` addressing. */
export const encodeFolderPath = (path: string): string =>
  path.split("/").filter(Boolean).map(encodeURIComponent).join("%2F");

const childrenPath = (driveId: string, incidentRoot: string): string =>
  incidentRoot
    ? `/drives/${driveId}/root:/${encodeFolderPath(incidentRoot)}:/children`
    : `/drives/${driveId}/root/children`;

/** Find the incident folder under the configured root by prefix match on its name. */
export const findIncidentFolder = async (
  graph: GraphPort,
  driveId: string,
  incidentRoot: string,
  inc: string
): Promise<DriveItemRef | null> => {
  const needle = inc.trim().toLowerCase();
  const items = await graph.getAllPages<GraphDriveItem>(childrenPath(driveId, incidentRoot));
  const hit = items.find((i) => i.folder && i.name.toLowerCase().startsWith(needle));
  return hit ? { id: hit.id, name: hit.name, webUrl: hit.webUrl } : null;
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm --workspace @sre/core run test -- locate.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/clients/sharepoint/locate.ts packages/core/src/clients/sharepoint/locate.test.ts
git commit -m "feat(core): locate incident folder by startswith match"
```

---

## Task 8: walkDocs (recursive subtree)

**Files:**
- Create: `packages/core/src/clients/sharepoint/walk.ts`
- Test: `packages/core/src/clients/sharepoint/walk.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect, vi } from "vitest";
import { walkDocs } from "./walk.js";

const folder = (name: string, id: string) => ({ id, name, folder: {} });
const file = (name: string, id: string, size = 10) => ({ id, name, file: {}, size, webUrl: `http://x/${name}` });

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
    for await (const f of walkDocs(graph as any, "d", "incF", "Docs", { maxFiles: 50 })) files.push(f);
    expect(files.map((f) => f.path)).toEqual(["Docs/a.docx", "Docs/sub/b.pdf", "Docs/sub/c.xlsx"]);
    expect(graph.getAllPages).not.toHaveBeenCalledWith("/drives/d/items/nb/children"); // IncidentNoteBook ignored
  });

  it("yields nothing when there is no Docs subfolder", async () => {
    const graph = fakeGraph({ "/drives/d/items/incF/children": [folder("Other", "o")] });
    const files = [];
    for await (const f of walkDocs(graph as any, "d", "incF", "Docs", { maxFiles: 50 })) files.push(f);
    expect(files).toEqual([]);
  });

  it("stops at maxFiles", async () => {
    const graph = fakeGraph({
      "/drives/d/items/incF/children": [folder("Docs", "docs")],
      "/drives/d/items/docs/children": [file("a", "a"), file("b", "b"), file("c", "c")]
    });
    const files = [];
    for await (const f of walkDocs(graph as any, "d", "incF", "Docs", { maxFiles: 2 })) files.push(f);
    expect(files.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --workspace @sre/core run test -- walk.test`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// packages/core/src/clients/sharepoint/walk.ts
import type { GraphPort, GraphDriveItem, DriveFile } from "./types.js";

const childrenById = (driveId: string, itemId: string) => `/drives/${driveId}/items/${itemId}/children`;

/**
 * Recurse the `<docsSubfolder>` subtree of the incident folder, yielding files
 * (depth-first, parent before children) with human-readable paths. Folders other
 * than the docs subfolder at the top level are ignored. Bounded by maxFiles.
 */
export async function* walkDocs(
  graph: GraphPort,
  driveId: string,
  incidentFolderId: string,
  docsSubfolder: string,
  opts: { maxFiles: number }
): AsyncGenerator<DriveFile> {
  const top = await graph.getAllPages<GraphDriveItem>(childrenById(driveId, incidentFolderId));
  const docs = top.find((i) => i.folder && i.name.toLowerCase() === docsSubfolder.toLowerCase());
  if (!docs) return;

  let yielded = 0;
  const stack: { id: string; path: string }[] = [{ id: docs.id, path: docs.name }];
  while (stack.length) {
    const node = stack.pop()!;
    const children = await graph.getAllPages<GraphDriveItem>(childrenById(driveId, node.id));
    const subdirs: { id: string; path: string }[] = [];
    for (const c of children) {
      const path = `${node.path}/${c.name}`;
      if (c.folder) {
        subdirs.push({ id: c.id, path });
      } else if (c.file) {
        yield { id: c.id, name: c.name, webUrl: c.webUrl, size: c.size ?? 0, path };
        if (++yielded >= opts.maxFiles) return;
      }
    }
    // push subdirs reversed so traversal reads left-to-right
    for (let i = subdirs.length - 1; i >= 0; i--) stack.push(subdirs[i]);
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm --workspace @sre/core run test -- walk.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/clients/sharepoint/walk.ts packages/core/src/clients/sharepoint/walk.test.ts
git commit -m "feat(core): recursive Docs-subtree walk yielding files"
```

---

## Task 9: extractText (format dispatch) + defaultParsers

**Files:**
- Create: `packages/core/src/clients/sharepoint/extract.ts`
- Create: `packages/core/src/clients/sharepoint/parsers.ts`
- Test: `packages/core/src/clients/sharepoint/extract.test.ts`

- [ ] **Step 1: Write failing tests (dispatch only — parsers are stubbed)**

```ts
import { describe, it, expect, vi } from "vitest";
import { extractText, formatOf } from "./extract.js";
import type { Parsers } from "./types.js";

const parsers: Parsers = {
  docx: vi.fn(async () => "docx-text"),
  xlsx: vi.fn(async () => "xlsx-text"),
  pptx: vi.fn(async () => "pptx-text"),
  pdf: vi.fn(async () => "pdf-text")
};

describe("formatOf", () => {
  it("maps known extensions, null otherwise", () => {
    expect(formatOf("a.DOCX")).toBe("docx");
    expect(formatOf("a.pdf")).toBe("pdf");
    expect(formatOf("a.doc")).toBeNull();   // legacy binary not supported
    expect(formatOf("a.txt")).toBeNull();
  });
});

describe("extractText", () => {
  it("dispatches by format", async () => {
    expect(await extractText("r.docx", Buffer.from(""), parsers)).toEqual({ text: "docx-text" });
    expect(await extractText("s.xlsx", Buffer.from(""), parsers)).toEqual({ text: "xlsx-text" });
  });

  it("skips unsupported formats", async () => {
    expect(await extractText("notes.one", Buffer.from(""), parsers)).toEqual({
      skipped: "unsupported format: .one"
    });
  });

  it("turns a parser error into a skip", async () => {
    const boom: Parsers = { ...parsers, pdf: vi.fn(async () => { throw new Error("corrupt"); }) };
    expect(await extractText("x.pdf", Buffer.from(""), boom)).toEqual({ skipped: "parse failed: corrupt" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --workspace @sre/core run test -- extract.test`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement extract.ts**

```ts
// packages/core/src/clients/sharepoint/extract.ts
import type { Parsers, ExtractResult, DocFormat } from "./types.js";

const EXT_TO_FORMAT: Record<string, DocFormat> = {
  docx: "docx",
  xlsx: "xlsx",
  pptx: "pptx",
  pdf: "pdf"
};

export const extOf = (name: string): string => {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
};

export const formatOf = (name: string): DocFormat | null => EXT_TO_FORMAT[extOf(name)] ?? null;

/** Extract plain text from a document buffer. Unknown format or parser failure → a skip reason. */
export const extractText = async (name: string, bytes: Buffer, parsers: Parsers): Promise<ExtractResult> => {
  const format = formatOf(name);
  if (!format) return { skipped: `unsupported format: .${extOf(name)}` };
  try {
    const text = await parsers[format](bytes);
    return { text };
  } catch (err) {
    return { skipped: `parse failed: ${err instanceof Error ? err.message : String(err)}` };
  }
};
```

- [ ] **Step 4: Implement parsers.ts (the real libs; thin adapters)**

```ts
// packages/core/src/clients/sharepoint/parsers.ts
import type { Parsers } from "./types.js";

/**
 * Real text extractors. Imports are dynamic so the heavy parser libs load only
 * when SharePoint is actually used. `pdf-parse` is imported via its inner module
 * path to avoid its package index reading a sample PDF at import time.
 */
export const defaultParsers: Parsers = {
  docx: async (b) => {
    const mammoth = await import("mammoth");
    const { value } = await mammoth.extractRawText({ buffer: b });
    return value;
  },
  xlsx: async (b) => {
    const XLSX = await import("xlsx");
    const wb = XLSX.read(b, { type: "buffer" });
    return wb.SheetNames.map((n) => `# ${n}\n${XLSX.utils.sheet_to_csv(wb.Sheets[n])}`).join("\n\n");
  },
  pptx: async (b) => {
    const op = await import("officeparser");
    return await op.parseOfficeAsync(b);
  },
  pdf: async (b) => {
    const mod = await import("pdf-parse/lib/pdf-parse.js");
    const pdf = (mod.default ?? mod) as (buf: Buffer) => Promise<{ text: string }>;
    const { text } = await pdf(b);
    return text;
  }
};
```

- [ ] **Step 5: Run to verify dispatch tests pass**

Run: `npm --workspace @sre/core run test -- extract.test`
Expected: PASS. (parsers.ts is exercised by the manual smoke in Task 15, not unit-tested — it is a thin wrapper over third-party libs.)

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/clients/sharepoint/extract.ts packages/core/src/clients/sharepoint/parsers.ts packages/core/src/clients/sharepoint/extract.test.ts
git commit -m "feat(core): document text extraction (format dispatch + real parsers)"
```

---

## Task 10: SharePointService (orchestration + budget)

**Files:**
- Create: `packages/core/src/services/sharepoint/index.ts`
- Test: `packages/core/src/services/sharepoint/index.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
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
const file = (name: string, id: string, size = 10) => ({ id, name, file: {}, size, webUrl: `http://x/${name}` });

// Fake GraphPort: site/drive via get(), children via getAllPages(), bytes via download().
const makeGraph = (children: Record<string, any[]>, bytes: Record<string, Buffer>) => ({
  get: vi.fn(async (p: string) =>
    p.endsWith("/drive") ? { id: "drive1" } : { id: "site1" }
  ),
  getAllPages: vi.fn(async (p: string) => children[p] ?? []),
  download: vi.fn(async (_d: string, itemId: string) => bytes[itemId] ?? Buffer.from(""))
});

const parsers: Parsers = {
  docx: async (b) => b.toString(),
  xlsx: async (b) => b.toString(),
  pptx: async (b) => b.toString(),
  pdf: async (b) => b.toString()
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
    expect(out.documents[0]).toMatchObject({ name: "a.docx", format: "docx", text: "hello", truncated: false });
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
        "/drives/drive1/items/docs/children": [file("huge.docx", "huge", 5_000_000), file("notes.txt", "n")]
      },
      {}
    );
    const svc = new SharePointService(cfg, graph as any, parsers);
    const out = await svc.getIncidentDocuments("INC1");
    expect(out.count).toBe(0);
    expect(out.skipped).toEqual([
      { name: "huge.docx", reason: "exceeds max file bytes (5000000 > 1000000)" },
      { name: "notes.txt", reason: "unsupported format: .txt" }
    ]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --workspace @sre/core run test -- services/sharepoint`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```ts
// packages/core/src/services/sharepoint/index.ts
import { AzRunner } from "../../clients/ado/az.js";
import { GraphTokenProvider } from "../../clients/sharepoint/token.js";
import { GraphClient } from "../../clients/sharepoint/graph.js";
import { resolveSite } from "../../clients/sharepoint/site.js";
import { findIncidentFolder } from "../../clients/sharepoint/locate.js";
import { walkDocs } from "../../clients/sharepoint/walk.js";
import { extractText, formatOf } from "../../clients/sharepoint/extract.js";
import { defaultParsers } from "../../clients/sharepoint/parsers.js";
import type {
  SharePointConfig, GraphPort, Parsers, IncidentDocsResult, IncidentDocument
} from "../../clients/sharepoint/types.js";

const estTokens = (chars: number): number => Math.ceil(chars / 4);

export class SharePointService {
  private site?: { siteId: string; driveId: string };

  constructor(
    private readonly cfg: SharePointConfig,
    private readonly graph: GraphPort,
    private readonly parsers: Parsers = defaultParsers
  ) {}

  private async drive(): Promise<string> {
    if (!this.site) this.site = await resolveSite(this.graph, this.cfg.siteUrl);
    return this.site.driveId;
  }

  async getIncidentDocuments(inc: string): Promise<IncidentDocsResult> {
    const driveId = await this.drive();
    const folder = await findIncidentFolder(this.graph, driveId, this.cfg.incidentRoot, inc);
    if (!folder) throw new Error(`No SharePoint folder found for ${inc}`);

    const documents: IncidentDocument[] = [];
    const skipped: { name: string; reason: string }[] = [];
    let usedTokens = 0;
    const budget = this.cfg.maxDocTokens;

    for await (const f of walkDocs(this.graph, driveId, folder.id, this.cfg.docsSubfolder, { maxFiles: this.cfg.maxFiles })) {
      const format = formatOf(f.name);
      if (!format) {
        skipped.push({ name: f.name, reason: `unsupported format: .${f.name.split(".").pop()}` });
        continue;
      }
      if (f.size > this.cfg.maxFileBytes) {
        skipped.push({ name: f.name, reason: `exceeds max file bytes (${f.size} > ${this.cfg.maxFileBytes})` });
        continue;
      }
      const bytes = await this.graph.download(driveId, f.id);
      const result = await extractText(f.name, bytes, this.parsers);
      if ("skipped" in result) {
        skipped.push({ name: f.name, reason: result.skipped });
        continue;
      }
      const remainingTokens = Math.max(0, budget - usedTokens);
      const remainingChars = remainingTokens * 4;
      const truncated = result.text.length > remainingChars;
      const text = truncated ? result.text.slice(0, remainingChars) : result.text;
      usedTokens += estTokens(text.length);
      documents.push({
        name: f.name,
        path: f.path,
        webUrl: f.webUrl,
        format,
        bytes: f.size,
        textChars: text.length,
        truncated,
        text
      });
    }

    return {
      incident: inc,
      folder: { name: folder.name, webUrl: folder.webUrl },
      count: documents.length,
      documents,
      totalChars: documents.reduce((s, d) => s + d.textChars, 0),
      truncatedCount: documents.filter((d) => d.truncated).length,
      skipped
    };
  }
}

/** Build a SharePointService backed by a live Graph client (az-CLI delegated token). */
export const createSharePointService = (cfg: SharePointConfig): SharePointService => {
  const token = new GraphTokenProvider({ az: new AzRunner(cfg.azPath) });
  const graph = new GraphClient({
    getToken: () => token.getToken(),
    proxyUrl: cfg.proxyUrl,
    timeoutMs: cfg.timeoutMs
  });
  return new SharePointService(cfg, graph);
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm --workspace @sre/core run test -- services/sharepoint`
Expected: PASS (all four cases).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/services/sharepoint/index.ts packages/core/src/services/sharepoint/index.test.ts
git commit -m "feat(core): SharePointService — locate→walk→extract under token budget"
```

---

## Task 11: Wire into runtime + exports

**Files:**
- Modify: `packages/core/src/runtime.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/runtime.test.ts` (append; create if absent)

- [ ] **Step 1: Write failing test**

Add to `packages/core/src/runtime.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { createMcpRuntime } from "./runtime.js";

const base = {
  SERVICENOW_BASE_URL: "https://sn.example.com",
  SERVICENOW_USERNAME: "u",
  SERVICENOW_PASSWORD: "p"
};

describe("runtime sharePoint wiring", () => {
  it("is undefined when disabled", () => {
    expect(createMcpRuntime(base).sharePoint).toBeUndefined();
  });
  it("is defined when enabled", () => {
    const rt = createMcpRuntime({
      ...base,
      SHAREPOINT_ENABLED: "true",
      SHAREPOINT_SITE_URL: "https://acme.sharepoint.com/sites/SRE"
    });
    expect(rt.sharePoint).toBeDefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --workspace @sre/core run test -- runtime.test`
Expected: FAIL (`sharePoint` not on runtime).

- [ ] **Step 3: Implement runtime wiring**

In `packages/core/src/runtime.ts`:
- Add import: `import { SharePointService, createSharePointService } from "./services/sharepoint/index.js";`
- In `McpRuntime` interface add: `sharePoint?: SharePointService;`
- In `createMcpRuntime`, after `const knowledge = new KnowledgeService(config.knowledge);` add:
  ```ts
  const sharePoint = config.sharePoint.enabled ? createSharePointService(config.sharePoint) : undefined;
  ```
- Add `sharePoint` to the returned object.

- [ ] **Step 4: Export from index.ts**

In `packages/core/src/index.ts`, add (matching existing export style):
```ts
export { SharePointService, createSharePointService } from "./services/sharepoint/index.js";
export type {
  SharePointConfig, IncidentDocsResult, IncidentDocument
} from "./clients/sharepoint/types.js";
```

- [ ] **Step 5: Run tests + build**

Run: `npm --workspace @sre/core run test -- runtime.test && npm --workspace @sre/core run build`
Expected: PASS + clean build.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/runtime.ts packages/core/src/index.ts packages/core/src/runtime.test.ts
git commit -m "feat(core): wire SharePointService into runtime (gated) + exports"
```

---

## Task 12: `get_incident_documents` tool — sre-agent (Copilot SDK)

**Files:**
- Modify: `packages/sre-agent/src/tools/index.ts`
- Test: `packages/sre-agent/src/tools/index.test.ts` (append; create if absent)

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from "vitest";
import { buildTools } from "./index.js";

const toolByName = (runtime: any, name: string) =>
  buildTools(runtime).find((t: any) => t.name === name);

describe("get_incident_documents tool", () => {
  it("returns the service result", async () => {
    const runtime: any = {
      sharePoint: { getIncidentDocuments: async (n: string) => ({ incident: n, count: 0, documents: [] }) }
    };
    const tool = toolByName(runtime, "get_incident_documents");
    const out = await tool.handler({ incident: "INC123456" });
    expect(out).toMatchObject({ incident: "INC123456", count: 0 });
  });

  it("reports a clear error when SharePoint is disabled", async () => {
    const tool = toolByName({ sharePoint: undefined }, "get_incident_documents");
    const out = await tool.handler({ incident: "INC1" });
    expect(out).toEqual({ error: "SharePoint integration is disabled (set SHAREPOINT_ENABLED=true)." });
  });

  it("never throws — wraps service errors", async () => {
    const runtime: any = {
      sharePoint: { getIncidentDocuments: async () => { throw new Error("boom"); } }
    };
    const tool = toolByName(runtime, "get_incident_documents");
    expect(await tool.handler({ incident: "INC1" })).toEqual({ error: "Error: boom" });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --workspace @sre/sre-agent run test -- tools/index.test`
Expected: FAIL (tool not defined).

- [ ] **Step 3: Implement — add the tool to the array**

In `packages/sre-agent/src/tools/index.ts`, add this entry to the array returned by `buildTools` (e.g. after the `search_knowledge` tool, before `index_url`):
```ts
  defineTool("get_incident_documents", {
    description:
      "Fetch an incident's supporting documents from SharePoint by incident number (e.g. INC123456). " +
      "Recursively reads the incident folder's Docs subtree (docx/xlsx/pptx/pdf) and returns extracted " +
      "text to read and cite. Use when the user references an incident and asks about its docs, runbook, " +
      "postmortem, or details that live in SharePoint rather than ServiceNow.",
    skipPermission: true,
    parameters: z.object({
      incident: z.string().describe("Incident number, e.g. INC123456")
    }),
    handler: async (a) => {
      try {
        if (!runtime.sharePoint) {
          return { error: "SharePoint integration is disabled (set SHAREPOINT_ENABLED=true)." };
        }
        return await runtime.sharePoint.getIncidentDocuments(a.incident);
      } catch (err) {
        return { error: String(err) };
      }
    }
  }),
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm --workspace @sre/sre-agent run test -- tools/index.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/sre-agent/src/tools/index.ts packages/sre-agent/src/tools/index.test.ts
git commit -m "feat(agent): get_incident_documents tool (SharePoint)"
```

---

## Task 13: `get_incident_documents` tool — mcp-server

**Files:**
- Create: `packages/mcp-server/src/tools/sharepoint.ts`
- Modify: `packages/mcp-server/src/server.ts`
- Test: `packages/mcp-server/src/tools/sharepoint.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, vi } from "vitest";
import { registerSharePointTools } from "./sharepoint.js";

const fakeServer = () => {
  const tools: Record<string, Function> = {};
  return {
    tool: (name: string, _d: string, _s: unknown, handler: Function) => { tools[name] = handler; },
    tools
  };
};

describe("registerSharePointTools", () => {
  it("registers get_incident_documents that returns JSON text", async () => {
    const server = fakeServer();
    const runtime: any = { sharePoint: { getIncidentDocuments: async (n: string) => ({ incident: n, count: 0 }) } };
    registerSharePointTools(server as any, runtime);
    const out = await server.tools["get_incident_documents"]({ incident: "INC1" });
    expect(out.content[0].text).toContain('"incident": "INC1"');
  });

  it("returns an isError result when disabled", async () => {
    const server = fakeServer();
    registerSharePointTools(server as any, { sharePoint: undefined } as any);
    const out = await server.tools["get_incident_documents"]({ incident: "INC1" });
    expect(out.isError).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --workspace @sre/mcp-server run test -- tools/sharepoint`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the tool module**

```ts
// packages/mcp-server/src/tools/sharepoint.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { McpRuntime } from "@sre/core";

const asText = (obj: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }]
});
const asError = (err: unknown) => ({
  content: [{ type: "text" as const, text: `Error: ${String(err)}` }],
  isError: true
});

export const registerSharePointTools = (server: McpServer, runtime: McpRuntime): void => {
  server.tool(
    "get_incident_documents",
    "Fetch an incident's SharePoint documents by number (docx/xlsx/pptx/pdf from the Docs subtree); returns extracted text to cite.",
    { incident: z.string().describe("Incident number, e.g. INC123456") },
    async (args) => {
      try {
        if (!runtime.sharePoint) {
          return asError("SharePoint integration is disabled (set SHAREPOINT_ENABLED=true).");
        }
        return asText(await runtime.sharePoint.getIncidentDocuments(args.incident));
      } catch (error) {
        return asError(error);
      }
    }
  );
};
```

- [ ] **Step 4: Wire into server.ts**

In `packages/mcp-server/src/server.ts`:
- Add import: `import { registerSharePointTools } from "./tools/sharepoint.js";`
- Next to the other `register*Tools(server, runtime)` calls, add: `registerSharePointTools(server, runtime);`

- [ ] **Step 5: Run tests + build**

Run: `npm --workspace @sre/mcp-server run test -- tools/sharepoint && npm --workspace @sre/mcp-server run build`
Expected: PASS + clean build.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp-server/src/tools/sharepoint.ts packages/mcp-server/src/server.ts packages/mcp-server/src/tools/sharepoint.test.ts
git commit -m "feat(mcp-server): get_incident_documents tool (SharePoint)"
```

---

## Task 14: Chat steering + agent gating flag + workflows

**Files:**
- Modify: `packages/sre-agent/src/config.ts`
- Modify: `packages/sre-agent/src/engine/engine.ts`
- Modify: `packages/sre-agent/src/workflows/index.ts`
- Test: `packages/sre-agent/src/config.test.ts` (append; create if absent)

- [ ] **Step 1: Write failing test for the gating flag**

```ts
import { describe, it, expect } from "vitest";
import { loadAgentConfig } from "./config.js";

const base = {
  SERVICENOW_BASE_URL: "https://sn.example.com",
  SERVICENOW_USERNAME: "u",
  SERVICENOW_PASSWORD: "p"
};

describe("sharePointEnabled flag", () => {
  it("false by default", () => {
    expect(loadAgentConfig(base).sharePointEnabled).toBe(false);
  });
  it("true when SHAREPOINT_ENABLED=true", () => {
    expect(loadAgentConfig({ ...base, SHAREPOINT_ENABLED: "true" }).sharePointEnabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm --workspace @sre/sre-agent run test -- config.test`
Expected: FAIL (`sharePointEnabled` undefined).

- [ ] **Step 3: Add the flag to AgentConfig**

In `packages/sre-agent/src/config.ts`:
- Add to the `schema` object: `SHAREPOINT_ENABLED: bool(false),`
- Add to the `AgentConfig` interface: `/** True when SharePoint is configured → steer chat toward get_incident_documents. */ sharePointEnabled: boolean;`
- In the returned object of `loadAgentConfig`, add: `sharePointEnabled: e.SHAREPOINT_ENABLED,`

- [ ] **Step 4: Run config test to verify it passes**

Run: `npm --workspace @sre/sre-agent run test -- config.test`
Expected: PASS.

- [ ] **Step 5: Add the SharePoint system instruction + combine nudges**

In `packages/sre-agent/src/engine/engine.ts`, after `KNOWLEDGE_SYSTEM_INSTRUCTION`, add:
```ts
/** Appended when SharePoint is configured: steer toward get_incident_documents for incident docs. */
export const SHAREPOINT_SYSTEM_INSTRUCTION =
  "This agent has a `get_incident_documents` tool that retrieves an incident's supporting documents " +
  "(docx/xlsx/pptx/pdf) from SharePoint by incident number. When the user references an incident number " +
  "and asks about its documentation, runbook, postmortem, or details that may live in SharePoint, call " +
  "`get_incident_documents` (alongside the ServiceNow tools) and cite the document names you used.";
```
Then replace the single-instruction `systemMessage` spread (the `...(cfg.knowledgeEnabled ? { systemMessage: ... } : {})` block, around line 126) with a combined builder. Just above the `const sessionConfig: SessionConfig = {` line add:
```ts
      const systemInstructions = [
        cfg.knowledgeEnabled ? KNOWLEDGE_SYSTEM_INSTRUCTION : null,
        cfg.sharePointEnabled ? SHAREPOINT_SYSTEM_INSTRUCTION : null
      ].filter(Boolean);
```
and replace the old spread line with:
```ts
        ...(systemInstructions.length
          ? { systemMessage: { mode: "append" as const, content: systemInstructions.join("\n\n") } }
          : {}),
```

- [ ] **Step 6: Add a workflow step to the two incident-centric workflows**

Only `/triage` and `/postmortem` carry an incident number (`/review` is a change, `/handover` is a team), so the step goes in those two only.

In `packages/sre-agent/src/workflows/index.ts`, in `triagePrompt`, immediately after the existing `search_knowledge` line:
```
If internal documentation is indexed, also call search_knowledge to find runbooks or known fixes for these symptoms, and cite the source URLs in your recommendations.
```
add a blank line and:
```
If SharePoint is configured, call get_incident_documents for ${incidentNumber} to pull the incident's supporting documents and incorporate/cite them.
```

In `postmortemPrompt`, immediately after its existing `search_knowledge` line:
```
Also call search_knowledge to check for an existing runbook or known issue for this failure, and flag any runbook gaps as action items.
```
add a blank line and:
```
If SharePoint is configured, call get_incident_documents for ${incidentNumber} to pull the incident's documents (timeline notes, comms, analysis) and incorporate them.
```
(Both prompt bodies are template literals that already interpolate `${incidentNumber}`, so the placeholder resolves directly.)

- [ ] **Step 7: Build + run the agent test suite**

Run: `npm --workspace @sre/sre-agent run build && npm --workspace @sre/sre-agent run test`
Expected: PASS (existing engine/workflow tests still green; if an engine test asserts on `systemMessage`, update it to expect the combined content).

- [ ] **Step 8: Commit**

```bash
git add packages/sre-agent/src/config.ts packages/sre-agent/src/engine/engine.ts packages/sre-agent/src/workflows/index.ts packages/sre-agent/src/config.test.ts
git commit -m "feat(agent): steer chat + workflows to get_incident_documents when SharePoint configured"
```

---

## Task 15: Doctor preflight

**Files:**
- Modify: `packages/sre-agent/src/doctor.ts`

The file defines `interface CheckResult { name; ok; detail?; fix? }`, builds each check as a `CheckResult`, and aggregates them in `runChecks()` (a `results: CheckResult[]` array). Mirror `checkKnowledge` (lines ~152-166), which builds its own runtime via `createMcpRuntime()`.

- [ ] **Step 1: Add `checkSharePoint`**

In `packages/sre-agent/src/doctor.ts`, after `checkKnowledge` (ends ~line 166), add:
```ts
const checkSharePoint = async (): Promise<CheckResult> => {
  try {
    const rt = createMcpRuntime();
    if (!rt.sharePoint) {
      return { name: "SharePoint", ok: true, detail: "disabled (SHAREPOINT_ENABLED not set)" };
    }
    // A non-existent incident still proves auth + site + base-folder listing work:
    // "No SharePoint folder found" means the pipeline reached the folder listing.
    await rt.sharePoint.getIncidentDocuments("__doctor_probe__");
    return { name: "SharePoint", ok: true, detail: "reachable" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("No SharePoint folder found")) {
      return { name: "SharePoint", ok: true, detail: "auth + site reachable (probe folder absent, as expected)" };
    }
    return {
      name: "SharePoint",
      ok: false,
      detail: msg.slice(0, 200),
      fix: "Check SHAREPOINT_SITE_URL and that `az login` has SharePoint/Graph access."
    };
  }
};
```
(`createMcpRuntime` and `CheckResult` are already imported/defined in this file.)

- [ ] **Step 2: Wire it into `runChecks`**

In `runChecks()`, inside the `if (config) { ... }` block, immediately after `results.push(await checkKnowledge());` add:
```ts
    if (config.raw.SHAREPOINT_ENABLED) {
      results.push(await checkSharePoint());
    }
```
(`config.raw.SHAREPOINT_ENABLED` is the parsed boolean added to the agent schema in Task 14 Step 3. The check is skipped entirely when SharePoint is off, so default installs see no new line.)

- [ ] **Step 3: Build**

Run: `npm --workspace @sre/sre-agent run build`
Expected: clean build.

- [ ] **Step 4: Commit**

```bash
git add packages/sre-agent/src/doctor.ts
git commit -m "feat(agent): doctor SharePoint preflight (auth + site reachability)"
```

---

## Task 16: Docs

**Files:**
- Modify: `packages/sre-agent/.env.example`
- Modify: `packages/sre-agent/README.md`
- Modify: `README.md`

- [ ] **Step 1: Document env in `.env.example`**

Add a SharePoint block:
```dotenv
# --- SharePoint incident docs (optional) ---
# When enabled, get_incident_documents fetches an incident's Docs subtree from SharePoint
# Online by incident number. Auth reuses the Azure CLI login (delegated Graph token) — no PAT.
SHAREPOINT_ENABLED=false
SHAREPOINT_SITE_URL=https://acme.sharepoint.com/sites/SRE
# SHAREPOINT_INCIDENT_ROOT=            # folder holding the INC###### folders (default: drive root)
# SHAREPOINT_DOCS_SUBFOLDER=Docs       # subfolder to recurse (default Docs)
# SHAREPOINT_PROXY=                    # HTTP proxy for Graph (corporate network)
# SHAREPOINT_MAX_DOC_TOKENS=50000      # inline text budget across all docs
# SHAREPOINT_MAX_FILES=50              # cap on files walked
# SHAREPOINT_MAX_FILE_BYTES=10485760   # skip files larger than this
```

- [ ] **Step 2: Add a "SharePoint incident docs" section to both READMEs**

In `packages/sre-agent/README.md` (Tools roster + a short section) and root `README.md`: document the tool `get_incident_documents`, the delegated-az-token auth, the `Docs`-subtree behavior, supported formats (docx/xlsx/pptx/pdf), the token-budget truncation, and that `IncidentNoteBook`/OneNote is excluded. Mention `doctor` covers a SharePoint preflight. Mirror the existing "Knowledge crawler (RAG)" section's depth and the 14→15-tool roster table count.

- [ ] **Step 3: Commit**

```bash
git add packages/sre-agent/.env.example packages/sre-agent/README.md README.md
git commit -m "docs: document SharePoint incident-docs integration"
```

---

## Task 17: Full build + test gate

**Files:** none (verification only)

- [ ] **Step 1: Build all workspaces**

Run: `npm run build`
Expected: clean across `@sre/core`, `@sre/mcp-server`, `@sre/sre-agent`.

- [ ] **Step 2: Run the full test suite**

Run: `npm test`
Expected: all green (244 prior + the new SharePoint tests).

- [ ] **Step 3: Manual smoke (real tenant, documented — not CI)**

With a real `.env` (`SHAREPOINT_ENABLED=true`, a real `SHAREPOINT_SITE_URL`, and a logged-in `az`):
```bash
npm start -- doctor
```
Expected: the SharePoint check reports reachable. Then in chat, ask about a real incident number and confirm the agent calls `get_incident_documents` and returns extracted text. Record the result in the PR description.

- [ ] **Step 4: Finalize**

Use the `superpowers:finishing-a-development-branch` skill to choose merge/PR/cleanup for `feature/sharepoint-incident-docs`.

---

## Self-Review notes (for the implementer)

- **Token-budget rule** matches the spec §5: single running budget, last-fitting doc truncated, subsequent docs still listed (here they get empty text because no budget remains — `truncatedCount` counts them via the `truncated` flag). If you prefer to *omit* zero-budget docs from `documents[]` and instead list them in `skipped[]`, that's an acceptable variation — pick one and keep the test in Task 10 in sync.
- **`formatOf` is reused** by both `extract.ts` and `SharePointService` (the service checks format before downloading to avoid fetching unsupported files). Keep the single source in `extract.ts`.
- **No live network in unit tests** — every test fakes `GraphPort` or `fetch`/`AzRunner`. `parsers.ts` is the only un-unit-tested unit; it is covered by the Task 17 manual smoke.
- **Anti-SSRF**: `siteUrl`/`incidentRoot` come only from config; the tool input is the incident number used as a `startswith` filter. Do not add any code path that lets the tool argument choose a site, drive, or arbitrary path.
