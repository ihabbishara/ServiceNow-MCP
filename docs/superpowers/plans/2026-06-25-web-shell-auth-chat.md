# Web Shell + Auth + Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a localhost browser front door (`packages/web`) for the existing SRE-agent `ChatEngine`: device-flow / BYOK auth, streaming chat, write-confirm, and a `.env` editor — no Copilot CLI install required.

**Architecture:** A new `packages/web` workspace runs a stdlib-`http` server on `127.0.0.1` that owns one `ChatEngine` (via an `engine-host` module) and serves a Vite/React/Tailwind client. Server→client uses SSE; client→server uses POST. The web layer is a second consumer of the same engine the CLI drives; the only edits to existing code are a device-code callback in `auth.ts` and an `exports` barrel on `@sre/sre-agent`.

**Tech Stack:** Node (stdlib `http`), TypeScript (NodeNext ESM, `tsc -b` composite project refs), Vite + React + Tailwind, vitest, `@github/copilot-sdk` (bundled `@github/copilot` runtime), `@sre/core`.

## Global Constraints

- **Node:** `^20.19 || >=22.12` (root `engines`).
- **Module system:** ESM (`"type": "module"`), TypeScript `module`/`moduleResolution`: `NodeNext`. Import local `.ts` as `.js` specifiers.
- **TS build:** every package extends `../../tsconfig.base.json`, is `composite: true`, `outDir: ./dist`, `rootDir: ./src` (server only), and lists `references` to `@sre/core` / `@sre/sre-agent` it imports. Build with `tsc -b`.
- **Tests:** vitest, run from repo root (`npm test` → `vitest run`). Test files live in `packages/<pkg>/tests/**`. No new test frameworks; no DOM test deps.
- **Binding:** the server listens on `127.0.0.1` only. No app-level password.
- **Secrets:** the `.env` editor reads/writes **all** vars (acceptable on loopback). Resolve the file via `resolveDotenvPath` from `@sre/sre-agent`.
- **Laziness markers:** deliberate ceilings get a `// ponytail:` comment naming the ceiling + upgrade path (e.g. single shared engine).
- **Commit message trailer:** end each commit body with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

## File Structure

**Modified (existing):**
- `packages/sre-agent/src/engine/auth.ts` — `copilotLogin` gains device-code capture; new `parseDeviceCode` + `DeviceCodeInfo`.
- `packages/sre-agent/src/cli/index.ts` — pass an `onDeviceCode` callback that prints to stdout (preserves terminal UX).
- `packages/sre-agent/tests/auth.test.ts` — extend fake spawn with a `stdout` stream.
- `packages/sre-agent/package.json` — add `main`/`types`/`exports`.
- `packages/sre-agent/src/index.ts` — **new** barrel re-exporting the public API.

**Created (`packages/web/`):**
- `package.json`, `tsconfig.json` (server), `tsconfig.node.json` + `vite.config.ts` + `tailwind.config.js` + `postcss.config.js` + `index.html` (client).
- `shared/events.ts` — `ServerEvent` union shared by server + client.
- `server/sse.ts` — SSE broadcaster.
- `server/dotenv-file.ts` — read/parse/write `.env`.
- `server/engine-host.ts` — owns the `ChatEngine`, runtime, confirm map, turn flag, event bus.
- `server/routes/{chat,auth,env}.ts` — request handlers.
- `server/index.ts` — server bootstrap (static + `/api`).
- `client/src/{main.tsx,App.tsx,state.ts,sse.ts,views/*}` — React UI.
- `tests/**` — vitest tests per module.

---

## Task 1: Export barrel for `@sre/sre-agent`

Unblocks `packages/web` importing the engine. Additive — the CLI `bin` is unaffected.

**Files:**
- Create: `packages/sre-agent/src/index.ts`
- Modify: `packages/sre-agent/package.json`
- Test: `packages/sre-agent/tests/exports.test.ts`

**Interfaces:**
- Produces: a barrel exporting `ChatEngine`, `buildClientOptions`, `EngineDeps`, `loadAgentConfig`, `AgentConfig`, `buildTools`, `copilotLogin`, `isCopilotAuthError`, `CopilotLoginOptions`, `loadDotenv`, `resolveDotenvPath`, `buildWorkflowPrompt`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/sre-agent/tests/exports.test.ts
import { describe, it, expect } from "vitest";
import * as api from "../src/index.js";

describe("public API barrel", () => {
  it("exports the symbols packages/web depends on", () => {
    for (const name of [
      "ChatEngine",
      "loadAgentConfig",
      "buildTools",
      "copilotLogin",
      "isCopilotAuthError",
      "loadDotenv",
      "resolveDotenvPath",
      "buildWorkflowPrompt",
    ]) {
      expect(api[name], name).toBeTypeOf("function");
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/sre-agent/tests/exports.test.ts`
Expected: FAIL — cannot resolve `../src/index.js` (file does not exist).

- [ ] **Step 3: Create the barrel**

```typescript
// packages/sre-agent/src/index.ts
export { ChatEngine, buildClientOptions } from "./engine/engine.js";
export type { EngineDeps } from "./engine/engine.js";
export { copilotLogin, isCopilotAuthError, resolveSdkRuntime } from "./engine/auth.js";
export type { CopilotLoginOptions } from "./engine/auth.js";
export { loadAgentConfig } from "./config.js";
export type { AgentConfig } from "./config.js";
export { loadDotenv, resolveDotenvPath, packageEnvPath } from "./config/env.js";
export { buildTools } from "./tools/index.js";
export { buildWorkflowPrompt } from "./workflows/index.js";
```

- [ ] **Step 4: Add package exports**

In `packages/sre-agent/package.json`, after the `"bin"` line add:

```json
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" }
  },
```

(Keep the existing `"bin"`, `"files"`, `"scripts"`, `"dependencies"`.)

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/sre-agent/tests/exports.test.ts`
Expected: PASS.

- [ ] **Step 6: Build to confirm the barrel compiles**

Run: `npm run build --workspace @sre/sre-agent`
Expected: exits 0; `packages/sre-agent/dist/index.js` + `index.d.ts` exist.

- [ ] **Step 7: Commit**

```bash
git add packages/sre-agent/src/index.ts packages/sre-agent/package.json packages/sre-agent/tests/exports.test.ts
git commit -m "feat(sre-agent): export public API barrel for the web package

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: `parseDeviceCode` helper

Pure function that extracts the device-flow URL + user code from `copilot login` stdout. Isolated so it is testable without spawning.

**Files:**
- Modify: `packages/sre-agent/src/engine/auth.ts` (add export near the top, below imports)
- Test: `packages/sre-agent/tests/device-code.test.ts`

**Interfaces:**
- Produces: `interface DeviceCodeInfo { verificationUri: string; userCode: string }` and `parseDeviceCode(buffer: string): DeviceCodeInfo | undefined`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/sre-agent/tests/device-code.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/sre-agent/tests/device-code.test.ts`
Expected: FAIL — `parseDeviceCode` is not exported.

- [ ] **Step 3: Implement the helper**

Add to `packages/sre-agent/src/engine/auth.ts` (after the imports, before `LoginChild`):

```typescript
export interface DeviceCodeInfo {
  verificationUri: string;
  userCode: string;
}

/**
 * Extract the device-flow verification URL + user code from accumulated
 * `copilot login` stdout. The two can print on separate lines, so callers pass
 * the running buffer, not a single chunk. Returns undefined until BOTH are seen.
 */
export const parseDeviceCode = (buffer: string): DeviceCodeInfo | undefined => {
  const verificationUri = buffer.match(/https?:\/\/\S*github\.com\/login\/device\S*/i)?.[0];
  const userCode = buffer.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/)?.[0];
  if (verificationUri && userCode) return { verificationUri, userCode };
  return undefined;
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/sre-agent/tests/device-code.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/sre-agent/src/engine/auth.ts packages/sre-agent/tests/device-code.test.ts
git commit -m "feat(sre-agent): parseDeviceCode helper for device-flow stdout

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: `copilotLogin` device-code capture

Switch the login child from `stdio: "inherit"` to capturing stdout, buffer it, fire `onDeviceCode` once. Preserve the resolve-on-exit-0 / reject-on-nonzero contract. Update the CLI call sites to pass an `onDeviceCode` that prints to stdout.

**Files:**
- Modify: `packages/sre-agent/src/engine/auth.ts` (`LoginChild`, `SpawnFn`, `CopilotLoginOptions`, `copilotLogin`)
- Modify: `packages/sre-agent/src/cli/index.ts` (`reloginCopilot`, `ensureCopilotAuth` call sites)
- Test: `packages/sre-agent/tests/auth.test.ts` (extend the existing fake spawn)

**Interfaces:**
- Consumes: `parseDeviceCode`, `DeviceCodeInfo` (Task 2).
- Produces: `copilotLogin(opts)` now accepts `onDeviceCode?: (info: DeviceCodeInfo) => void`. `LoginChild` now exposes `stdout` (a readable emitting `"data"`). `SpawnFn` returns a `LoginChild` and is called with `stdio: ["ignore", "pipe", "inherit"]`.

- [ ] **Step 1: Read the existing test to learn the current fake**

Run: `sed -n '1,80p' packages/sre-agent/tests/auth.test.ts`
Expected: see how the current fake `LoginChild` (an EventEmitter) is injected via `spawnFn`. The new fake must additionally expose `.stdout` (an `EventEmitter`).

- [ ] **Step 2: Write the failing test**

Add to `packages/sre-agent/tests/auth.test.ts`:

```typescript
import { EventEmitter } from "node:events";
import { copilotLogin } from "../src/engine/auth.js";

describe("copilotLogin device-code capture", () => {
  it("fires onDeviceCode when the URL + code stream on stdout, resolves on exit 0", async () => {
    const stdout = new EventEmitter();
    const child = Object.assign(new EventEmitter(), { stdout });
    const seen: unknown[] = [];

    const promise = copilotLogin({
      resolveBin: () => "/fake/index.js",
      execPath: "/usr/bin/node",
      spawnFn: () => child as never,
      onDeviceCode: (info) => seen.push(info),
    });

    stdout.emit("data", Buffer.from("Open https://github.com/login/device "));
    stdout.emit("data", Buffer.from("and enter WDJB-MJHT\n"));
    child.emit("close", 0);

    await expect(promise).resolves.toBeUndefined();
    expect(seen).toEqual([
      { verificationUri: "https://github.com/login/device", userCode: "WDJB-MJHT" },
    ]);
  });

  it("rejects on non-zero exit", async () => {
    const stdout = new EventEmitter();
    const child = Object.assign(new EventEmitter(), { stdout });
    const promise = copilotLogin({
      resolveBin: () => "/fake/index.js",
      execPath: "/usr/bin/node",
      spawnFn: () => child as never,
    });
    child.emit("close", 7);
    await expect(promise).rejects.toThrow(/exited with code 7/);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run packages/sre-agent/tests/auth.test.ts -t "device-code capture"`
Expected: FAIL — `onDeviceCode` unsupported / `child.stdout` unused (no callback fired).

- [ ] **Step 4: Update the types and `copilotLogin`**

In `packages/sre-agent/src/engine/auth.ts`:

Replace the `LoginChild` interface:

```typescript
export interface LoginChild {
  stdout: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown };
  on(event: "close", listener: (code: number | null) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
}
```

Replace the `SpawnFn` type:

```typescript
export type SpawnFn = (
  command: string,
  args: string[],
  options: { stdio: ["ignore", "pipe", "inherit"]; env: NodeJS.ProcessEnv }
) => LoginChild;
```

Add to `CopilotLoginOptions`:

```typescript
  /** Invoked once when the device-flow URL + user code are parsed from stdout. */
  onDeviceCode?: (info: DeviceCodeInfo) => void;
```

Replace the body of `copilotLogin` (the spawn + promise section) with:

```typescript
  return new Promise<void>((resolve, reject) => {
    const child = spawnFn(command, args, { stdio: ["ignore", "pipe", "inherit"], env });
    let buffer = "";
    let fired = false;
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      if (!fired && opts.onDeviceCode) {
        const info = parseDeviceCode(buffer);
        if (info) {
          fired = true;
          opts.onDeviceCode(info);
        }
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`copilot login exited with code ${code ?? "unknown"}`));
    });
  });
```

(Keep the existing `command`/`args`/`env`/`isJs` resolution above this block unchanged.)

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/sre-agent/tests/auth.test.ts`
Expected: PASS (existing auth tests + the 2 new ones).

- [ ] **Step 6: Update the CLI call sites to keep terminal UX**

In `packages/sre-agent/src/cli/index.ts`, change `reloginCopilot`'s login call:

```typescript
  await copilotLogin({
    home: config.copilot.home,
    onDeviceCode: ({ verificationUri, userCode }) =>
      process.stdout.write(`\nTo log in, open ${verificationUri} and enter code: ${userCode}\n`),
  });
```

- [ ] **Step 7: Build the package**

Run: `npm run build --workspace @sre/sre-agent`
Expected: exits 0.

- [ ] **Step 8: Commit**

```bash
git add packages/sre-agent/src/engine/auth.ts packages/sre-agent/src/cli/index.ts packages/sre-agent/tests/auth.test.ts
git commit -m "feat(sre-agent): capture device code in copilotLogin via onDeviceCode

stdio inherit->pipe(stdout); buffer + parseDeviceCode fire the callback once.
CLI passes a callback that prints the URL+code, preserving terminal UX.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: `packages/web` scaffold + shared event type

A buildable empty package with both build systems (tsc for server, Vite for client) and the shared `ServerEvent` type. Deliverable: the server boots on an ephemeral port and serves a placeholder page.

**Files:**
- Create: `packages/web/package.json`, `packages/web/tsconfig.json`, `packages/web/tsconfig.node.json`, `packages/web/vite.config.ts`, `packages/web/tailwind.config.js`, `packages/web/postcss.config.js`, `packages/web/index.html`, `packages/web/shared/events.ts`, `packages/web/server/index.ts`, `packages/web/client/src/main.tsx`, `packages/web/client/src/App.tsx`, `packages/web/client/src/index.css`
- Test: `packages/web/tests/server-boot.test.ts`

**Interfaces:**
- Produces: `ServerEvent` union (in `shared/events.ts`); `createServer(host: EngineHostLike): http.Server` is added in Task 9 — here `server/index.ts` exposes only `startServer(opts: { port: number }): Promise<http.Server>` serving static files + a `GET /api/health` returning `{ ok: true }`.

- [ ] **Step 1: Create `shared/events.ts`**

```typescript
// packages/web/shared/events.ts
export type EngineState = "starting" | "ready" | "restarting" | "error";

export type ServerEvent =
  | { type: "delta"; text: string }
  | { type: "tool-start"; name: string }
  | { type: "turn-end" }
  | { type: "turn-error"; message: string; isAuthError: boolean }
  | { type: "confirm-request"; id: string; summary: string }
  | { type: "device-code"; verificationUri: string; userCode: string }
  | {
      type: "auth-status";
      isAuthenticated: boolean;
      authType?: string;
      login?: string;
      ambientEnvWarning: boolean;
    }
  | { type: "engine-state"; state: EngineState; message?: string };
```

- [ ] **Step 2: Create `package.json`**

```json
{
  "name": "@sre/web",
  "version": "0.1.0",
  "type": "module",
  "files": ["dist/", "client/dist/"],
  "scripts": {
    "build": "tsc -b && vite build",
    "build:server": "tsc -b",
    "build:client": "vite build",
    "dev": "vite",
    "start": "node dist/server/index.js"
  },
  "dependencies": {
    "@sre/sre-agent": "*",
    "@sre/core": "*"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^4.3.0",
    "autoprefixer": "^10.4.0",
    "postcss": "^8.4.0",
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "tailwindcss": "^3.4.0",
    "vite": "^5.4.0"
  }
}
```

- [ ] **Step 3: Create server `tsconfig.json` (compiles `server/` + `shared/` only)**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": ".",
    "composite": true,
    "tsBuildInfoFile": "./dist/.tsbuildinfo"
  },
  "include": ["server/**/*", "shared/**/*"],
  "references": [{ "path": "../core" }, { "path": "../sre-agent" }]
}
```

- [ ] **Step 4: Create client `tsconfig.node.json` + Vite/Tailwind config**

```json
// packages/web/tsconfig.node.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "lib": ["ES2022", "DOM", "DOM.Iterable"], "jsx": "react-jsx", "noEmit": true },
  "include": ["client/**/*", "shared/**/*", "vite.config.ts"]
}
```

```typescript
// packages/web/vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: ".",
  plugins: [react()],
  build: { outDir: "client/dist" },
  server: { proxy: { "/api": "http://127.0.0.1:4317" } },
});
```

```javascript
// packages/web/tailwind.config.js
export default { content: ["./index.html", "./client/src/**/*.{ts,tsx}"], theme: { extend: {} }, plugins: [] };
```

```javascript
// packages/web/postcss.config.js
export default { plugins: { tailwindcss: {}, autoprefixer: {} } };
```

- [ ] **Step 5: Create the client entry + placeholder**

```html
<!-- packages/web/index.html -->
<!doctype html>
<html lang="en">
  <head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><title>SRE Agent</title></head>
  <body><div id="root"></div><script type="module" src="/client/src/main.tsx"></script></body>
</html>
```

```css
/* packages/web/client/src/index.css */
@tailwind base;
@tailwind components;
@tailwind utilities;
```

```tsx
// packages/web/client/src/main.tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
```

```tsx
// packages/web/client/src/App.tsx
export function App() {
  return <h1 className="text-xl font-semibold p-4">SRE Agent</h1>;
}
```

- [ ] **Step 6: Create the placeholder server**

```typescript
// packages/web/server/index.ts
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";

const clientDist = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "client", "dist");

export const startServer = (opts: { port: number }): Promise<Server> => {
  const server = createServer(async (req, res) => {
    if (req.url === "/api/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    // Serve the built client; fall back to index.html (SPA).
    const rel = normalize(req.url === "/" || !req.url ? "/index.html" : req.url).replace(/^(\.\.[/\\])+/, "");
    try {
      const body = await readFile(join(clientDist, rel));
      res.writeHead(200);
      res.end(body);
    } catch {
      try {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(await readFile(join(clientDist, "index.html")));
      } catch {
        res.writeHead(404);
        res.end("not found");
      }
    }
  });
  return new Promise((resolve) =>
    server.listen(opts.port, "127.0.0.1", () => resolve(server))
  );
};
```

- [ ] **Step 7: Write the boot test**

```typescript
// packages/web/tests/server-boot.test.ts
import { describe, it, expect, afterAll } from "vitest";
import type { Server } from "node:http";
import { AddressInfo } from "node:net";
import { startServer } from "../server/index.js";

let server: Server;
afterAll(() => server?.close());

describe("startServer", () => {
  it("binds 127.0.0.1 and answers /api/health", async () => {
    server = await startServer({ port: 0 });
    const { port, address } = server.address() as AddressInfo;
    expect(address).toBe("127.0.0.1");
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
```

- [ ] **Step 8: Install deps + run the test**

Run: `npm install`
Run: `npx vitest run packages/web/tests/server-boot.test.ts`
Expected: PASS (the test imports the `.ts` server directly via vitest; no build needed).

- [ ] **Step 9: Verify both builds compile**

Run: `npm run build --workspace @sre/web`
Expected: exits 0; `packages/web/dist/server/index.js` and `packages/web/client/dist/index.html` exist.

- [ ] **Step 10: Ensure `.gitignore` covers client build**

Confirm `dist/` is already ignored (root `.gitignore`). If `client/dist` is not covered, add `packages/web/client/dist/` to `.gitignore`.

Run: `git check-ignore packages/web/client/dist || echo NOT_IGNORED`
If `NOT_IGNORED`, append `packages/web/client/dist/` to `.gitignore`.

- [ ] **Step 11: Commit**

```bash
git add packages/web .gitignore package-lock.json
git commit -m "feat(web): scaffold packages/web (stdlib server + Vite/React/Tailwind)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: SSE broadcaster

A tiny event bus that fans `ServerEvent`s out to all connected SSE responses and formats the wire frame.

**Files:**
- Create: `packages/web/server/sse.ts`
- Test: `packages/web/tests/sse.test.ts`

**Interfaces:**
- Produces: `formatSse(event: ServerEvent): string`; `class SseHub { add(res): () => void; broadcast(event: ServerEvent): void; count(): number }`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/web/tests/sse.test.ts
import { describe, it, expect } from "vitest";
import { formatSse, SseHub } from "../server/sse.js";

describe("formatSse", () => {
  it("serializes an event as a single data frame", () => {
    expect(formatSse({ type: "delta", text: "hi" })).toBe(`data: {"type":"delta","text":"hi"}\n\n`);
  });
});

describe("SseHub", () => {
  it("broadcasts to every connection and stops after removal", () => {
    const hub = new SseHub();
    const writes: string[] = [];
    const fakeRes = { write: (s: string) => writes.push(s) } as never;
    const remove = hub.add(fakeRes);
    expect(hub.count()).toBe(1);
    hub.broadcast({ type: "turn-end" });
    expect(writes).toEqual([`data: {"type":"turn-end"}\n\n`]);
    remove();
    expect(hub.count()).toBe(0);
    hub.broadcast({ type: "turn-end" });
    expect(writes.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/web/tests/sse.test.ts`
Expected: FAIL — `../server/sse.js` does not exist.

- [ ] **Step 3: Implement**

```typescript
// packages/web/server/sse.ts
import type { ServerResponse } from "node:http";
import type { ServerEvent } from "../shared/events.js";

export const formatSse = (event: ServerEvent): string => `data: ${JSON.stringify(event)}\n\n`;

/** Fans ServerEvents out to connected SSE responses. */
export class SseHub {
  private clients = new Set<Pick<ServerResponse, "write">>();

  add(res: Pick<ServerResponse, "write">): () => void {
    this.clients.add(res);
    return () => this.clients.delete(res);
  }

  broadcast(event: ServerEvent): void {
    const frame = formatSse(event);
    for (const res of this.clients) res.write(frame);
  }

  count(): number {
    return this.clients.size;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/web/tests/sse.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web/server/sse.ts packages/web/tests/sse.test.ts
git commit -m "feat(web): SSE broadcaster

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: `.env` file read/parse/write

Reads the resolved `.env` into key/value pairs and writes edits back, preserving keys not in the schema. Used by the env editor.

**Files:**
- Create: `packages/web/server/dotenv-file.ts`
- Test: `packages/web/tests/dotenv-file.test.ts`

**Interfaces:**
- Produces: `parseEnv(text: string): Record<string,string>`; `serializeEnv(vars: Record<string,string>): string`; `readEnvFile(path: string): Promise<Record<string,string>>`; `writeEnvFile(path: string, vars: Record<string,string>): Promise<void>`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/web/tests/dotenv-file.test.ts
import { describe, it, expect } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv, serializeEnv, writeEnvFile, readEnvFile } from "../server/dotenv-file.js";

describe("parseEnv", () => {
  it("parses KEY=VALUE lines, ignoring blanks and comments", () => {
    expect(parseEnv("# c\nA=1\n\nB=two words\n")).toEqual({ A: "1", B: "two words" });
  });
});

describe("serializeEnv", () => {
  it("emits one KEY=VALUE per line, trailing newline", () => {
    expect(serializeEnv({ A: "1", B: "x" })).toBe("A=1\nB=x\n");
  });
});

describe("round-trip", () => {
  it("writes then reads back the same map", async () => {
    const dir = await mkdtemp(join(tmpdir(), "envtest-"));
    const path = join(dir, ".env");
    await writeEnvFile(path, { FOO: "bar", BAZ: "qux quux" });
    expect(await readEnvFile(path)).toEqual({ FOO: "bar", BAZ: "qux quux" });
    expect(await readFile(path, "utf8")).toContain("FOO=bar");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/web/tests/dotenv-file.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

```typescript
// packages/web/server/dotenv-file.ts
import { readFile, writeFile } from "node:fs/promises";

export const parseEnv = (text: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
};

export const serializeEnv = (vars: Record<string, string>): string =>
  Object.entries(vars)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n") + "\n";

export const readEnvFile = async (path: string): Promise<Record<string, string>> => {
  try {
    return parseEnv(await readFile(path, "utf8"));
  } catch {
    return {};
  }
};

export const writeEnvFile = (path: string, vars: Record<string, string>): Promise<void> =>
  writeFile(path, serializeEnv(vars), "utf8");
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/web/tests/dotenv-file.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web/server/dotenv-file.ts packages/web/tests/dotenv-file.test.ts
git commit -m "feat(web): .env read/parse/write

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: `engine-host` — events, send/busy, confirm round-trip, abort

The stateful core. Owns the `ChatEngine` (built with a fake `clientFactory` in tests), the SSE-bound event bus, the pending-confirm map, and the single-turn guard. Lifecycle wiring to the real runtime/config comes in Task 8.

**Files:**
- Create: `packages/web/server/engine-host.ts`
- Test: `packages/web/tests/engine-host.test.ts`

**Interfaces:**
- Consumes: `ChatEngine`, `buildTools`, `buildWorkflowPrompt`, `isCopilotAuthError`, `AgentConfig` from `@sre/sre-agent`; `SseHub` (Task 5); `ServerEvent` (Task 4).
- Produces:

```typescript
export interface EngineHost {
  subscribe(res): () => void;          // attach an SSE response, returns detach
  send(prompt: string): Promise<void>; // expands workflow, guards single-turn (throws BusyError if running)
  resolveConfirm(id: string, approve: boolean): void;
  abort(): Promise<void>;
  isTurnRunning(): boolean;
  emit(event: ServerEvent): void;      // used internally + by routes
}
export class BusyError extends Error {}
```

The host builds `ChatEngine` with callbacks bound to `emit`:
`onDelta: (text) => emit({type:"delta",text})`, `onToolStart: (name) => emit({type:"tool-start",name})`, and a `confirm` that parks a Promise in a `Map<string,(b:boolean)=>void>` + emits `confirm-request`.

- [ ] **Step 1: Write the failing test (confirm round-trip + busy guard)**

```typescript
// packages/web/tests/engine-host.test.ts
import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createEngineHost, BusyError } from "../server/engine-host.js";
import type { ServerEvent } from "../shared/events.js";

// Minimal fake ChatEngine: captures the deps the host passes, lets us drive a turn.
class FakeEngine {
  static last: FakeEngine;
  constructor(public deps: any) { FakeEngine.last = this; }
  start = vi.fn(async () => {});
  stop = vi.fn(async () => {});
  abort = vi.fn(async () => {});
  getAuthStatus = vi.fn(async () => ({ isAuthenticated: true, authType: "user", login: "me" }));
  // Simulate a turn that asks for a write confirm, then completes.
  send = vi.fn(async (_prompt: string) => {
    const approved = await this.deps.confirm("delete X?");
    this.deps.onDelta(approved ? "did it" : "skipped");
  });
}

const makeHost = (events: ServerEvent[]) =>
  createEngineHost({
    config: { llm: { mode: "seat", model: "gpt-5" } } as any,
    tools: [],
    engineFactory: (deps) => new FakeEngine(deps) as any,
    emit: (e) => events.push(e),
    idFactory: () => "fixed-id",
  });

describe("engine-host confirm round-trip", () => {
  it("emits confirm-request, blocks until resolveConfirm, then streams the result", async () => {
    const events: ServerEvent[] = [];
    const host = makeHost(events);
    await host.start();

    const turn = host.send("/triage INC123"); // workflow expansion still resolves to a prompt
    await vi.waitFor(() =>
      expect(events.some((e) => e.type === "confirm-request")).toBe(true)
    );
    host.resolveConfirm("fixed-id", true);
    await turn;

    expect(events).toContainEqual({ type: "confirm-request", id: "fixed-id", summary: "delete X?" });
    expect(events).toContainEqual({ type: "delta", text: "did it" });
    expect(events).toContainEqual({ type: "turn-end" });
  });

  it("rejects a second concurrent send with BusyError", async () => {
    const events: ServerEvent[] = [];
    const host = makeHost(events);
    await host.start();
    const first = host.send("hello");
    await expect(host.send("again")).rejects.toBeInstanceOf(BusyError);
    host.resolveConfirm("fixed-id", false);
    await first;
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/web/tests/engine-host.test.ts`
Expected: FAIL — `../server/engine-host.js` missing.

- [ ] **Step 3: Implement `engine-host.ts` (core only)**

```typescript
// packages/web/server/engine-host.ts
import type { ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import {
  ChatEngine,
  buildWorkflowPrompt,
  isCopilotAuthError,
  type AgentConfig,
  type EngineDeps,
} from "@sre/sre-agent";
import type { Tool } from "@github/copilot-sdk";
import { SseHub } from "./sse.js";
import type { ServerEvent } from "../shared/events.js";

export class BusyError extends Error {
  constructor() {
    super("a turn is already running");
    this.name = "BusyError";
  }
}

const CONFIRM_TIMEOUT_MS = 5 * 60_000;

export interface EngineHostOptions {
  config: AgentConfig;
  tools: Tool<unknown>[];
  /** Seam: defaults to `new ChatEngine(deps)`; tests inject a fake. */
  engineFactory?: (deps: EngineDeps) => ChatEngine;
  /** Seam: defaults to the SseHub broadcast; tests capture events. */
  emit?: (event: ServerEvent) => void;
  /** Seam: defaults to randomUUID; tests pin confirm ids. */
  idFactory?: () => string;
  hub?: SseHub;
}

export interface EngineHost {
  hub: SseHub;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(prompt: string): Promise<void>;
  resolveConfirm(id: string, approve: boolean): void;
  abort(): Promise<void>;
  isTurnRunning(): boolean;
  authStatus(): Promise<void>;
  emit(event: ServerEvent): void;
}

export const createEngineHost = (opts: EngineHostOptions): EngineHost => {
  const hub = opts.hub ?? new SseHub();
  const emit = opts.emit ?? ((e: ServerEvent) => hub.broadcast(e));
  const newId = opts.idFactory ?? randomUUID;
  const engineFactory = opts.engineFactory ?? ((deps: EngineDeps) => new ChatEngine(deps));
  const pending = new Map<string, (approve: boolean) => void>();
  let turnRunning = false;

  const confirm = (summary: string): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      const id = newId();
      const timer = setTimeout(() => {
        if (pending.delete(id)) resolve(false); // ponytail: closed tab -> decline, never wedge a turn
      }, CONFIRM_TIMEOUT_MS);
      pending.set(id, (approve) => {
        clearTimeout(timer);
        pending.delete(id);
        resolve(approve);
      });
      emit({ type: "confirm-request", id, summary });
    });

  const engine = engineFactory({
    config: opts.config,
    tools: opts.tools,
    confirm,
    onDelta: (text) => emit({ type: "delta", text }),
    onToolStart: (name) => emit({ type: "tool-start", name }),
  });

  const authStatus = async () => {
    try {
      const s = await engine.getAuthStatus();
      emit({
        type: "auth-status",
        isAuthenticated: s.isAuthenticated,
        authType: s.authType,
        login: s.login,
        ambientEnvWarning: s.authType === "env" && !opts.config.copilot?.githubToken,
      });
    } catch (e) {
      emit({ type: "engine-state", state: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  return {
    hub,
    emit,
    isTurnRunning: () => turnRunning,
    async start() {
      emit({ type: "engine-state", state: "starting" });
      await engine.start();
      emit({ type: "engine-state", state: "ready" });
      await authStatus();
    },
    async stop() {
      await engine.stop();
    },
    async send(prompt) {
      if (turnRunning) throw new BusyError();
      turnRunning = true;
      try {
        await engine.send(buildWorkflowPrompt(prompt) ?? prompt);
        emit({ type: "turn-end" });
      } catch (e) {
        emit({
          type: "turn-error",
          message: e instanceof Error ? e.message : String(e),
          isAuthError: isCopilotAuthError(e),
        });
      } finally {
        turnRunning = false;
      }
    },
    resolveConfirm(id, approve) {
      pending.get(id)?.(approve);
    },
    async abort() {
      await engine.abort();
    },
    authStatus,
  };
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/web/tests/engine-host.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web/server/engine-host.ts packages/web/tests/engine-host.test.ts
git commit -m "feat(web): engine-host core (events, send/busy guard, confirm round-trip)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: `engine-host` lifecycle — login + `.env` reload + restart

Add the runtime-backed lifecycle: a `login()` that runs `copilotLogin` (device code → SSE) then restarts; an `applyEnv()` that validates a new `.env`, restarts the engine, and closes the old core runtime. The runtime is injected so tests don't load `onnxruntime`.

**Files:**
- Modify: `packages/web/server/engine-host.ts`
- Test: `packages/web/tests/engine-host-lifecycle.test.ts`

**Interfaces:**
- Consumes: `copilotLogin`, `loadAgentConfig`, `resolveDotenvPath`, `loadDotenv` from `@sre/sre-agent`; `readEnvFile`, `writeEnvFile` (Task 6).
- Produces (added to `EngineHost`):

```typescript
  login(): Promise<void>;                                  // device code -> SSE, then restart
  readEnv(): Promise<Record<string,string>>;               // current .env vars
  applyEnv(vars: Record<string,string>): Promise<{ ok: true } | { ok: false; issues: string }>;
```

`EngineHostOptions` gains `runtimeFactory?: () => { knowledge: { close(): Promise<unknown> } }` and `loginFn?: typeof copilotLogin` and `loadConfig?: typeof loadAgentConfig` and `envPath?: string` seams (all default to the real imports).

- [ ] **Step 1: Write the failing test**

```typescript
// packages/web/tests/engine-host-lifecycle.test.ts
import { describe, it, expect, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEngineHost } from "../server/engine-host.js";
import type { ServerEvent } from "../shared/events.js";

class FakeEngine {
  constructor(public deps: any) {}
  start = vi.fn(async () => {});
  stop = vi.fn(async () => {});
  abort = vi.fn(async () => {});
  send = vi.fn(async () => {});
  getAuthStatus = vi.fn(async () => ({ isAuthenticated: true, authType: "user", login: "me" }));
}

const baseConfig = { llm: { mode: "seat", model: "gpt-5" }, copilot: {} } as any;

describe("engine-host login", () => {
  it("runs copilotLogin, forwards the device code as an SSE event, then restarts", async () => {
    const events: ServerEvent[] = [];
    const loginFn = vi.fn(async (o: any) => {
      o.onDeviceCode({ verificationUri: "https://github.com/login/device", userCode: "WDJB-MJHT" });
    });
    const host = createEngineHost({
      config: baseConfig,
      tools: [],
      engineFactory: (d) => new FakeEngine(d) as any,
      runtimeFactory: () => ({ knowledge: { close: async () => {} } }),
      loginFn: loginFn as any,
      emit: (e) => events.push(e),
    });
    await host.start();
    await host.login();
    expect(loginFn).toHaveBeenCalledOnce();
    expect(events).toContainEqual({
      type: "device-code",
      verificationUri: "https://github.com/login/device",
      userCode: "WDJB-MJHT",
    });
  });
});

describe("engine-host applyEnv", () => {
  it("rejects invalid config without restarting", async () => {
    const dir = await mkdtemp(join(tmpdir(), "host-"));
    const events: ServerEvent[] = [];
    const loadConfig = vi.fn(() => {
      throw new Error("Invalid configuration:\n  SERVICENOW_BASE_URL: Required");
    });
    const host = createEngineHost({
      config: baseConfig,
      tools: [],
      engineFactory: (d) => new FakeEngine(d) as any,
      runtimeFactory: () => ({ knowledge: { close: async () => {} } }),
      loadConfig: loadConfig as any,
      envPath: join(dir, ".env"),
      emit: (e) => events.push(e),
    });
    await host.start();
    const result = await host.applyEnv({ FOO: "bar" });
    expect(result).toEqual({ ok: false, issues: expect.stringContaining("SERVICENOW_BASE_URL") });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/web/tests/engine-host-lifecycle.test.ts`
Expected: FAIL — `login`/`applyEnv` not on the host.

- [ ] **Step 3: Extend `engine-host.ts`**

Add these imports at the top:

```typescript
import {
  copilotLogin,
  loadAgentConfig,
  resolveDotenvPath,
  loadDotenv,
} from "@sre/sre-agent";
import { readEnvFile, writeEnvFile } from "./dotenv-file.js";
```

Add to `EngineHostOptions`:

```typescript
  runtimeFactory?: () => { knowledge: { close(): Promise<unknown> } };
  loginFn?: typeof copilotLogin;
  loadConfig?: typeof loadAgentConfig;
  envPath?: string;
```

Inside `createEngineHost`, after the existing setup, add the seams + lifecycle. Replace the returned object so it also restarts the underlying engine. Because the core engine is created once, refactor the engine into a mutable holder:

```typescript
  const runtimeFactory = opts.runtimeFactory;
  const loginFn = opts.loginFn ?? copilotLogin;
  const loadConfig = opts.loadConfig ?? loadAgentConfig;
  const envPath = opts.envPath ?? resolveDotenvPath();
  let config = opts.config;

  const buildEngine = (cfg: AgentConfig) =>
    engineFactory({
      config: cfg,
      tools: opts.tools,
      confirm,
      onDelta: (text) => emit({ type: "delta", text }),
      onToolStart: (name) => emit({ type: "tool-start", name }),
    });

  let engine = buildEngine(config);
  let runtime = runtimeFactory?.();
```

Then change `start`/`stop` to use the holder, and add:

```typescript
    async login() {
      await loginFn({
        home: config.copilot?.home,
        onDeviceCode: (info) =>
          emit({ type: "device-code", verificationUri: info.verificationUri, userCode: info.userCode }),
      });
      await restart();
    },
    async readEnv() {
      return envPath ? readEnvFile(envPath) : {};
    },
    async applyEnv(vars) {
      if (!envPath) return { ok: false as const, issues: "no .env path resolved" };
      let nextConfig: AgentConfig;
      try {
        nextConfig = loadConfig({ ...process.env, ...vars }); // validate BEFORE writing
      } catch (e) {
        return { ok: false as const, issues: e instanceof Error ? e.message : String(e) };
      }
      await writeEnvFile(envPath, vars);
      if (loadDotenv) loadDotenv(); // refresh process.env from the file
      config = nextConfig;
      await restart();
      return { ok: true as const };
    },
```

Add a `restart` helper (above the returned object):

```typescript
  const restart = async () => {
    emit({ type: "engine-state", state: "restarting" });
    await engine.stop();
    await runtime?.knowledge.close().catch(() => {}); // ONNX: dispose before re-create
    engine = buildEngine(config);
    runtime = runtimeFactory?.();
    await engine.start();
    emit({ type: "engine-state", state: "ready" });
    await authStatus();
  };
```

(Update `start`/`stop`/`send`/`abort`/`authStatus` to reference the mutable `engine` holder, not a `const`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/web/tests/engine-host-lifecycle.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the whole web suite to catch regressions**

Run: `npx vitest run packages/web`
Expected: PASS (server-boot, sse, dotenv-file, engine-host, engine-host-lifecycle).

- [ ] **Step 6: Commit**

```bash
git add packages/web/server/engine-host.ts packages/web/tests/engine-host-lifecycle.test.ts
git commit -m "feat(web): engine-host lifecycle (device-flow login, .env reload, restart)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: HTTP routes + server wiring

Wire the engine-host into the http server: SSE stream, chat/confirm/abort, auth status/login, env get/put. Replaces the placeholder `startServer` with one that takes a host.

**Files:**
- Create: `packages/web/server/routes/chat.ts`, `packages/web/server/routes/auth.ts`, `packages/web/server/routes/env.ts`
- Modify: `packages/web/server/index.ts`
- Test: `packages/web/tests/routes.test.ts`

**Interfaces:**
- Consumes: `EngineHost` (Tasks 7–8), `SseHub`.
- Produces: `createApp(host: EngineHost): (req, res) => void` (the request handler); `startServer(opts: { port: number; host?: EngineHost }): Promise<Server>` builds a real host from config when none is injected.

- [ ] **Step 1: Write the failing test (SSE delta + busy + env 400)**

```typescript
// packages/web/tests/routes.test.ts
import { describe, it, expect, afterAll, vi } from "vitest";
import type { Server } from "node:http";
import { AddressInfo } from "node:net";
import { startServer } from "../server/index.js";
import { createEngineHost } from "../server/engine-host.js";

class FakeEngine {
  constructor(public deps: any) {}
  start = vi.fn(async () => {});
  stop = vi.fn(async () => {});
  abort = vi.fn(async () => {});
  getAuthStatus = vi.fn(async () => ({ isAuthenticated: true, authType: "user", login: "me" }));
  send = vi.fn(async () => this.deps.onDelta("hello"));
}

const servers: Server[] = [];
afterAll(() => servers.forEach((s) => s.close()));

const boot = async () => {
  const host = createEngineHost({
    config: { llm: { mode: "seat", model: "gpt-5" }, copilot: {} } as any,
    tools: [],
    engineFactory: (d) => new FakeEngine(d) as any,
    runtimeFactory: () => ({ knowledge: { close: async () => {} } }),
  });
  await host.start();
  const server = await startServer({ port: 0, host });
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
};

describe("routes", () => {
  it("streams a delta over SSE after POST /api/chat", async () => {
    const base = await boot();
    const es = await fetch(`${base}/api/stream`);
    const reader = es.body!.getReader();
    await fetch(`${base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "hi" }),
    });
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain(`"type":"delta"`);
    expect(text).toContain("hello");
    await reader.cancel();
  });

  it("PUT /api/env with invalid config returns 400", async () => {
    const base = await boot();
    const res = await fetch(`${base}/api/env`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ vars: { LLM_MODE: "nonsense" } }),
    });
    expect([400, 409]).toContain(res.status); // 400 invalid; never 500
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/web/tests/routes.test.ts`
Expected: FAIL — `startServer` does not accept `host` / routes missing.

- [ ] **Step 3: Implement the route handlers**

```typescript
// packages/web/server/routes/chat.ts
import type { IncomingMessage, ServerResponse } from "node:http";
import type { EngineHost } from "../engine-host.js";
import { BusyError } from "../engine-host.js";
import { readJson, sendJson } from "./util.js";

export const handleStream = (req: IncomingMessage, res: ServerResponse, host: EngineHost) => {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.write(": connected\n\n");
  const detach = host.hub.add(res);
  req.on("close", detach);
};

export const handleChat = async (req: IncomingMessage, res: ServerResponse, host: EngineHost) => {
  const { prompt } = await readJson<{ prompt: string }>(req);
  try {
    void host.send(prompt); // fire-and-stream; result arrives over SSE
    sendJson(res, 202, { accepted: true });
  } catch (e) {
    if (e instanceof BusyError) return sendJson(res, 409, { error: "busy" });
    throw e;
  }
};

export const handleConfirm = async (req: IncomingMessage, res: ServerResponse, host: EngineHost) => {
  const { id, approve } = await readJson<{ id: string; approve: boolean }>(req);
  host.resolveConfirm(id, approve);
  sendJson(res, 200, { ok: true });
};

export const handleAbort = async (_req: IncomingMessage, res: ServerResponse, host: EngineHost) => {
  await host.abort();
  sendJson(res, 200, { ok: true });
};
```

Note: `host.send` throws `BusyError` synchronously before the turn starts, so the `try/catch` around `void host.send(prompt)` catches it. (Implement `send` to throw synchronously when `turnRunning` — in Task 7 it does, before the `await`.)

```typescript
// packages/web/server/routes/util.ts
import type { IncomingMessage, ServerResponse } from "node:http";

export const readJson = async <T>(req: IncomingMessage): Promise<T> => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString() || "{}") as T;
};

export const sendJson = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
```

```typescript
// packages/web/server/routes/auth.ts
import type { IncomingMessage, ServerResponse } from "node:http";
import type { EngineHost } from "../engine-host.js";
import { sendJson } from "./util.js";

export const handleAuthStatus = async (_req: IncomingMessage, res: ServerResponse, host: EngineHost) => {
  await host.authStatus(); // emits auth-status over SSE
  sendJson(res, 200, { ok: true });
};

export const handleLogin = async (_req: IncomingMessage, res: ServerResponse, host: EngineHost) => {
  void host.login(); // device-code + restart stream over SSE
  sendJson(res, 202, { accepted: true });
};
```

```typescript
// packages/web/server/routes/env.ts
import type { IncomingMessage, ServerResponse } from "node:http";
import type { EngineHost } from "../engine-host.js";
import { readJson, sendJson } from "./util.js";

export const handleGetEnv = async (_req: IncomingMessage, res: ServerResponse, host: EngineHost) => {
  sendJson(res, 200, { vars: await host.readEnv() });
};

export const handlePutEnv = async (req: IncomingMessage, res: ServerResponse, host: EngineHost) => {
  const { vars } = await readJson<{ vars: Record<string, string> }>(req);
  const result = await host.applyEnv(vars);
  if (result.ok) return sendJson(res, 200, { ok: true });
  sendJson(res, 400, { error: "invalid config", issues: result.issues });
};
```

- [ ] **Step 4: Rewrite `server/index.ts` to route + serve static**

```typescript
// packages/web/server/index.ts
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";
import { createEngineHost, type EngineHost } from "./engine-host.js";
import { handleStream, handleChat, handleConfirm, handleAbort } from "./routes/chat.js";
import { handleAuthStatus, handleLogin } from "./routes/auth.js";
import { handleGetEnv, handlePutEnv } from "./routes/env.js";
import { sendJson } from "./routes/util.js";

const clientDist = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "client", "dist");

type Handler = (req: IncomingMessage, res: ServerResponse, host: EngineHost) => unknown;
const routes: Record<string, Partial<Record<string, Handler>>> = {
  "GET /api/health": { GET: (_q, res) => sendJson(res, 200, { ok: true }) } as never,
};

export const createApp =
  (host: EngineHost) =>
  async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = (req.url ?? "/").split("?")[0];
    const m = `${req.method} ${url}`;
    try {
      if (m === "GET /api/health") return sendJson(res, 200, { ok: true });
      if (m === "GET /api/stream") return void handleStream(req, res, host);
      if (m === "POST /api/chat") return void (await handleChat(req, res, host));
      if (m === "POST /api/confirm") return void (await handleConfirm(req, res, host));
      if (m === "POST /api/abort") return void (await handleAbort(req, res, host));
      if (m === "GET /api/auth/status") return void (await handleAuthStatus(req, res, host));
      if (m === "POST /api/auth/login") return void (await handleLogin(req, res, host));
      if (m === "GET /api/env") return void (await handleGetEnv(req, res, host));
      if (m === "PUT /api/env") return void (await handlePutEnv(req, res, host));
      // static
      const rel = normalize(url === "/" ? "/index.html" : url).replace(/^(\.\.[/\\])+/, "");
      try {
        res.writeHead(200);
        res.end(await readFile(join(clientDist, rel)));
      } catch {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(await readFile(join(clientDist, "index.html")));
      }
    } catch (e) {
      sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  };

export const startServer = async (opts: { port: number; host?: EngineHost }): Promise<Server> => {
  const host =
    opts.host ??
    (await (async () => {
      // Real bootstrap path is exercised by `npm start`, not unit tests.
      const { loadAgentConfig, loadDotenv, buildTools } = await import("@sre/sre-agent");
      const { createMcpRuntime } = await import("@sre/core");
      loadDotenv();
      const runtime = createMcpRuntime();
      const h = createEngineHost({ config: loadAgentConfig(), tools: buildTools(runtime), runtimeFactory: () => runtime });
      await h.start();
      return h;
    })());
  const server = createServer(createApp(host));
  return new Promise((resolve) => server.listen(opts.port, "127.0.0.1", () => resolve(server)));
};

// Entrypoint: `npm start` runs the built dist/server/index.js directly.
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.WEB_PORT ?? 4317);
  startServer({ port }).then(() => console.log(`SRE Agent UI on http://127.0.0.1:${port}`));
}
```

(Delete the now-obsolete `routes` const placeholder if the linter flags it.)

- [ ] **Step 5: Update the boot test import if needed**

The Task 4 `server-boot.test.ts` calls `startServer({ port: 0 })` with no host. That now triggers the real bootstrap (`createMcpRuntime`, `loadAgentConfig`) which needs a valid `.env`. Change that test to inject a fake host like `routes.test.ts` does, OR keep it asserting only `/api/health` by injecting a minimal host. Simplest: update `server-boot.test.ts` to pass a fake host (copy the `boot()` helper's host construction).

- [ ] **Step 6: Run tests**

Run: `npx vitest run packages/web`
Expected: PASS (all web tests, including routes).

- [ ] **Step 7: Build**

Run: `npm run build:server --workspace @sre/web`
Expected: exits 0.

- [ ] **Step 8: Commit**

```bash
git add packages/web/server packages/web/tests
git commit -m "feat(web): HTTP routes + server wiring (SSE, chat, confirm, abort, auth, env)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 10: React client

The UI: an SSE hook, a pure `applyServerEvent` reducer (unit-tested, no DOM), and views for chat, login (device code), the write-confirm dialog, and the `.env` settings editor.

**Files:**
- Create: `packages/web/client/src/state.ts`, `packages/web/client/src/sse.ts`, `packages/web/client/src/api.ts`, `packages/web/client/src/views/Chat.tsx`, `packages/web/client/src/views/Login.tsx`, `packages/web/client/src/views/ConfirmDialog.tsx`, `packages/web/client/src/views/EnvSettings.tsx`
- Modify: `packages/web/client/src/App.tsx`
- Test: `packages/web/tests/state.test.ts`

**Interfaces:**
- Consumes: `ServerEvent` from `shared/events.ts`.
- Produces: `interface ChatState`, `initialState`, `applyServerEvent(state, event): ChatState`.

- [ ] **Step 1: Write the failing reducer test**

```typescript
// packages/web/tests/state.test.ts
import { describe, it, expect } from "vitest";
import { applyServerEvent, initialState } from "../client/src/state.js";

describe("applyServerEvent", () => {
  it("accumulates delta text into the streaming buffer, flushes on turn-end", () => {
    let s = initialState;
    s = applyServerEvent(s, { type: "delta", text: "Hel" });
    s = applyServerEvent(s, { type: "delta", text: "lo" });
    expect(s.streaming).toBe("Hello");
    s = applyServerEvent(s, { type: "turn-end" });
    expect(s.streaming).toBe("");
    expect(s.messages.at(-1)).toEqual({ role: "assistant", text: "Hello" });
  });

  it("records a confirm request and clears it elsewhere", () => {
    let s = applyServerEvent(initialState, { type: "confirm-request", id: "x", summary: "delete?" });
    expect(s.confirm).toEqual({ id: "x", summary: "delete?" });
  });

  it("stores the device code", () => {
    const s = applyServerEvent(initialState, {
      type: "device-code",
      verificationUri: "https://github.com/login/device",
      userCode: "WDJB-MJHT",
    });
    expect(s.deviceCode).toEqual({ verificationUri: "https://github.com/login/device", userCode: "WDJB-MJHT" });
  });

  it("surfaces the ambient-env warning from auth-status", () => {
    const s = applyServerEvent(initialState, {
      type: "auth-status",
      isAuthenticated: true,
      authType: "env",
      ambientEnvWarning: true,
    });
    expect(s.auth.ambientEnvWarning).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/web/tests/state.test.ts`
Expected: FAIL — `../client/src/state.js` missing.

- [ ] **Step 3: Implement the reducer**

```typescript
// packages/web/client/src/state.ts
import type { ServerEvent, EngineState } from "../../shared/events.js";

export interface ChatMessage { role: "user" | "assistant"; text: string }
export interface ChatState {
  messages: ChatMessage[];
  streaming: string;
  engineState: EngineState;
  auth: { isAuthenticated: boolean; authType?: string; login?: string; ambientEnvWarning: boolean };
  deviceCode?: { verificationUri: string; userCode: string };
  confirm?: { id: string; summary: string };
  error?: { message: string; isAuthError: boolean };
}

export const initialState: ChatState = {
  messages: [],
  streaming: "",
  engineState: "starting",
  auth: { isAuthenticated: false, ambientEnvWarning: false },
};

export const applyServerEvent = (s: ChatState, e: ServerEvent): ChatState => {
  switch (e.type) {
    case "delta":
      return { ...s, streaming: s.streaming + e.text };
    case "turn-end":
      return {
        ...s,
        messages: s.streaming ? [...s.messages, { role: "assistant", text: s.streaming }] : s.messages,
        streaming: "",
      };
    case "turn-error":
      return { ...s, streaming: "", error: { message: e.message, isAuthError: e.isAuthError } };
    case "confirm-request":
      return { ...s, confirm: { id: e.id, summary: e.summary } };
    case "device-code":
      return { ...s, deviceCode: { verificationUri: e.verificationUri, userCode: e.userCode } };
    case "auth-status":
      return {
        ...s,
        deviceCode: undefined,
        auth: {
          isAuthenticated: e.isAuthenticated,
          authType: e.authType,
          login: e.login,
          ambientEnvWarning: e.ambientEnvWarning,
        },
      };
    case "engine-state":
      return { ...s, engineState: e.state };
    case "tool-start":
      return s; // surfaced transiently elsewhere; no state change
    default:
      return s;
  }
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/web/tests/state.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Implement the SSE hook + API helpers (no test — thin glue)**

```typescript
// packages/web/client/src/sse.ts
import { useEffect, useReducer } from "react";
import { applyServerEvent, initialState, type ChatState } from "./state.js";
import type { ServerEvent } from "../../shared/events.js";

export const useServerStream = (): ChatState => {
  const [state, dispatch] = useReducer(applyServerEvent, initialState);
  useEffect(() => {
    const es = new EventSource("/api/stream");
    es.onmessage = (m) => dispatch(JSON.parse(m.data) as ServerEvent);
    return () => es.close();
  }, []);
  return state;
};
```

```typescript
// packages/web/client/src/api.ts
const post = (url: string, body?: unknown) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });

export const sendPrompt = (prompt: string) => post("/api/chat", { prompt });
export const answerConfirm = (id: string, approve: boolean) => post("/api/confirm", { id, approve });
export const abortTurn = () => post("/api/abort");
export const startLogin = () => post("/api/auth/login");
export const getEnv = () => fetch("/api/env").then((r) => r.json() as Promise<{ vars: Record<string, string> }>);
export const putEnv = (vars: Record<string, string>) =>
  fetch("/api/env", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ vars }) });
```

- [ ] **Step 6: Implement the views**

```tsx
// packages/web/client/src/views/ConfirmDialog.tsx
import { answerConfirm } from "../api.js";
export function ConfirmDialog({ confirm }: { confirm: { id: string; summary: string } }) {
  return (
    <div className="fixed inset-0 bg-black/40 grid place-items-center">
      <div className="bg-white rounded-lg p-6 max-w-md shadow-xl">
        <p className="mb-4">{confirm.summary}</p>
        <div className="flex gap-2 justify-end">
          <button className="px-3 py-1 rounded border" onClick={() => answerConfirm(confirm.id, false)}>Deny</button>
          <button className="px-3 py-1 rounded bg-blue-600 text-white" onClick={() => answerConfirm(confirm.id, true)}>Approve</button>
        </div>
      </div>
    </div>
  );
}
```

```tsx
// packages/web/client/src/views/Login.tsx
import { startLogin } from "../api.js";
export function Login({ deviceCode }: { deviceCode?: { verificationUri: string; userCode: string } }) {
  return (
    <div className="p-6 max-w-md">
      <h2 className="text-lg font-semibold mb-3">Sign in to GitHub Copilot</h2>
      {deviceCode ? (
        <p>Open <a className="text-blue-600 underline" href={deviceCode.verificationUri} target="_blank" rel="noreferrer">{deviceCode.verificationUri}</a> and enter code <code className="font-mono font-bold">{deviceCode.userCode}</code></p>
      ) : (
        <button className="px-4 py-2 rounded bg-blue-600 text-white" onClick={() => startLogin()}>Sign in with GitHub Copilot</button>
      )}
    </div>
  );
}
```

```tsx
// packages/web/client/src/views/Chat.tsx
import { useState } from "react";
import { sendPrompt, abortTurn } from "../api.js";
import type { ChatState } from "../state.js";
export function Chat({ state }: { state: ChatState }) {
  const [input, setInput] = useState("");
  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-auto p-4 space-y-3">
        {state.messages.map((m, i) => (
          <div key={i} className={m.role === "user" ? "text-right" : ""}><span className="inline-block rounded px-3 py-2 bg-gray-100">{m.text}</span></div>
        ))}
        {state.streaming && <div><span className="inline-block rounded px-3 py-2 bg-gray-50">{state.streaming}</span></div>}
        {state.error && <div className="text-red-600 text-sm">{state.error.message}{state.error.isAuthError && " — try signing in again."}</div>}
      </div>
      <form className="p-3 border-t flex gap-2" onSubmit={(e) => { e.preventDefault(); if (input.trim()) { sendPrompt(input); setInput(""); } }}>
        <input className="flex-1 border rounded px-3 py-2" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask about incidents, changes, ADO work items…" />
        <button className="px-4 py-2 rounded bg-blue-600 text-white" type="submit">Send</button>
        <button className="px-3 py-2 rounded border" type="button" onClick={() => abortTurn()}>Stop</button>
      </form>
    </div>
  );
}
```

```tsx
// packages/web/client/src/views/EnvSettings.tsx
import { useEffect, useState } from "react";
import { getEnv, putEnv } from "../api.js";
export function EnvSettings() {
  const [vars, setVars] = useState<Record<string, string>>({});
  const [issues, setIssues] = useState<string>();
  useEffect(() => { getEnv().then((r) => setVars(r.vars)); }, []);
  const save = async () => {
    const res = await putEnv(vars);
    setIssues(res.ok ? undefined : (await res.json()).issues);
  };
  return (
    <div className="p-4 space-y-2">
      <h2 className="text-lg font-semibold">Environment (.env)</h2>
      {Object.entries(vars).map(([k, v]) => (
        <div key={k} className="flex gap-2 items-center">
          <label className="w-56 font-mono text-sm">{k}</label>
          <input className="flex-1 border rounded px-2 py-1" value={v} onChange={(e) => setVars({ ...vars, [k]: e.target.value })} />
        </div>
      ))}
      {issues && <pre className="text-red-600 text-sm whitespace-pre-wrap">{issues}</pre>}
      <button className="px-4 py-2 rounded bg-blue-600 text-white" onClick={save}>Save &amp; restart</button>
    </div>
  );
}
```

- [ ] **Step 7: Wire `App.tsx`**

```tsx
// packages/web/client/src/App.tsx
import { useState } from "react";
import { useServerStream } from "./sse.js";
import { Chat } from "./views/Chat.js";
import { Login } from "./views/Login.js";
import { ConfirmDialog } from "./views/ConfirmDialog.js";
import { EnvSettings } from "./views/EnvSettings.js";

export function App() {
  const state = useServerStream();
  const [tab, setTab] = useState<"chat" | "settings">("chat");
  return (
    <div className="h-screen flex flex-col">
      <header className="flex items-center gap-4 px-4 py-2 border-b">
        <strong>SRE Agent</strong>
        <nav className="flex gap-2 text-sm">
          <button onClick={() => setTab("chat")} className={tab === "chat" ? "font-semibold" : ""}>Chat</button>
          <button onClick={() => setTab("settings")} className={tab === "settings" ? "font-semibold" : ""}>Settings</button>
        </nav>
        <span className="ml-auto text-xs text-gray-500">{state.engineState}{state.auth.login ? ` · ${state.auth.login}` : ""}</span>
      </header>
      {state.auth.ambientEnvWarning && (
        <div className="bg-amber-100 text-amber-900 text-sm px-4 py-2">Warning: an ambient env token resolved — if turns 403, unset GH_TOKEN/GITHUB_TOKEN or set COPILOT_GITHUB_TOKEN.</div>
      )}
      <main className="flex-1 overflow-hidden">
        {!state.auth.isAuthenticated ? <Login deviceCode={state.deviceCode} /> : tab === "chat" ? <Chat state={state} /> : <EnvSettings />}
      </main>
      {state.confirm && <ConfirmDialog confirm={state.confirm} />}
    </div>
  );
}
```

- [ ] **Step 8: Run reducer test + typecheck the client**

Run: `npx vitest run packages/web/tests/state.test.ts`
Expected: PASS.
Run: `npx tsc -p packages/web/tsconfig.node.json --noEmit`
Expected: exits 0 (client types check).

- [ ] **Step 9: Build the client**

Run: `npm run build --workspace @sre/web`
Expected: exits 0; `packages/web/client/dist/index.html` regenerated.

- [ ] **Step 10: Commit**

```bash
git add packages/web/client packages/web/tests/state.test.ts
git commit -m "feat(web): React client (chat, device-flow login, confirm dialog, .env editor)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 11: End-to-end smoke + docs

Verify the whole package builds and the full suite passes; add a short README so the next person can run it.

**Files:**
- Create: `packages/web/README.md`
- Test: (none new — runs the suite)

- [ ] **Step 1: Full build**

Run: `npm run build`
Expected: exits 0 across all workspaces (core, sre-agent, mcp-server, web).

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: PASS — the prior 239 tests plus the new web + auth tests, 0 failures.

- [ ] **Step 3: Manual smoke (documented, not automated)**

Run: `npm start --workspace @sre/web` (after a `.env` exists; `npm run init --workspace @sre/sre-agent` scaffolds one).
Open `http://127.0.0.1:4317`. Expected: Login screen → "Sign in" shows a device URL + code → after browser auth, chat streams; Settings tab edits `.env`.

- [ ] **Step 4: Write the README**

```markdown
# @sre/web

Localhost browser UI for the SRE agent. Wraps the existing `ChatEngine`:
device-flow Copilot login (no CLI install), BYOK, streaming chat, write-confirm,
and a `.env` editor.

## Run

    npm run build --workspace @sre/web
    npm start --workspace @sre/web   # serves http://127.0.0.1:4317

Dev (hot client + API proxy):

    npm run dev --workspace @sre/web

## Notes

- Binds `127.0.0.1` only; no app password — Copilot login is the only auth.
- The `.env` editor reads/writes every var, including secrets. Loopback only.
- One shared engine / one in-flight turn (single-user). See the design spec for the
  multi-user upgrade path: `docs/superpowers/specs/2026-06-25-web-shell-auth-chat-design.md`.
```

- [ ] **Step 5: Commit**

```bash
git add packages/web/README.md
git commit -m "docs(web): README + e2e smoke verification

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review notes (addressed)

- **Spec coverage:** auth methods → Tasks 3,7,8 (device flow) + config (BYOK already wired, exposed via `.env` editor Tasks 6,8,9,10); SSE+POST contract → Tasks 5,9,10; write-confirm round-trip → Task 7; device-code capture → Tasks 2,3; `.env` editor (all vars) → Tasks 6,8,9,10; exports prereq → Task 1; error handling (turn-error/isAuthError, ambient-env warning) → Tasks 7,10; testing → every task; out-of-scope B/C → untouched.
- **Type consistency:** `ServerEvent` defined once (Task 4) and consumed by `sse.ts`, `engine-host.ts`, `state.ts`. `EngineHost.send` throws `BusyError` synchronously (relied on by Task 9's route). `applyEnv` returns the discriminated `{ok:true} | {ok:false;issues}` used by Task 9's 400 path and Task 10's `EnvSettings`.
- **Known seams:** `engineFactory`, `runtimeFactory`, `loginFn`, `loadConfig`, `emit`, `idFactory`, `envPath`, and `host` injection keep every task testable without a live Copilot seat or `onnxruntime`.
- **Port:** the server defaults to `4317` (referenced in README + Vite proxy); `startServer` takes an explicit `port` (tests use `0`).
