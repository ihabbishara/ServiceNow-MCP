# Web UI Engagement Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `@sre/web` chat readable and alive — render assistant markdown (incl. GFM tables), show a busy/thinking indicator during a turn, and replace the top nav with a left sidebar surfacing integration status, model, and clickable workflow commands.

**Architecture:** Four tasks. (1) Backend emits a config-derived `config-status` event. (2) The pure client reducer gains `busy`/`activeTool`/`config`. (3) `Chat.tsx` renders assistant bubbles through a `react-markdown` component and shows the busy indicator. (4) A `Sidebar.tsx` + `App.tsx` layout replaces the top bar, adds a `success` green token, and lifts the chat input so workflow clicks can fill it.

**Tech Stack:** TypeScript (ESM/NodeNext), React + Vite, Tailwind (ING tokens), vitest, `react-markdown` + `remark-gfm`.

## Global Constraints

- ESM/NodeNext: all relative imports use explicit `.js` specifiers.
- Design grep MUST stay empty: `grep -rnE '(bg|text|border|ring)-(blue|gray|red|green|amber|slate|zinc|indigo|purple)-[0-9]' packages/web/client/src` → no matches. New colors are **named tokens**, never raw `-NNN` classes.
- **No emoji** anywhere in UI. Status dots are styled `<span>` elements.
- **Respect `prefers-reduced-motion`**: animations use the `motion-safe:` variant only.
- `ServerEvent` (in `shared/events.ts`) is the client/server contract — extend it, don't fork it.
- Frequent commits: one per task.
- Run all commands from the worktree root `/Users/ihabbishara/projects/ServiceNowMCP/.claude/worktrees/session-2026-06-24`.

---

### Task 1: `config-status` event + engine-host derivation

**Files:**
- Modify: `packages/web/shared/events.ts`
- Modify: `packages/web/server/engine-host.ts`
- Test: `packages/web/tests/engine-host.test.ts`

**Interfaces:**
- Produces: a new `ServerEvent` member
  `{ type: "config-status"; llmMode: "seat" | "byok"; model: string; provider?: string; servicenow: boolean; ado: boolean; rag: boolean }`.
  The host emits it on `start()` and after `restart()`, and includes it in `snapshot()`.

- [ ] **Step 1: Write the failing test**

Add to `packages/web/tests/engine-host.test.ts`. Note the existing `makeHost` builds a thin config; this test calls `createEngineHost` directly with a fuller config + a runtime so the derived booleans are exercised.

```ts
import { createEngineHost } from "../server/engine-host.js";

describe("engine-host config-status", () => {
  const fullConfig = {
    llm: { mode: "seat", model: "gpt-5" },
    adoAuthMode: "pat",
    confirmWrites: true,
    copilot: { ignoreEnvToken: true },
    raw: { SERVICENOW_BASE_URL: "https://x.service-now.com", ADO_PAT: "p" },
  } as any;

  const makeFullHost = (events: ServerEvent[]) =>
    createEngineHost({
      config: fullConfig,
      tools: [],
      engineFactory: (deps) => new FakeEngine(deps) as any,
      emit: (e) => events.push(e),
      idFactory: () => "fixed-id",
      runtimeFactory: () => ({ knowledge: { close: async () => {} } }),
    });

  it("emits config-status with config-derived flags on start()", async () => {
    const events: ServerEvent[] = [];
    const host = makeFullHost(events);
    await host.start();
    const cs = events.find((e) => e.type === "config-status");
    expect(cs).toMatchObject({
      type: "config-status",
      llmMode: "seat",
      model: "gpt-5",
      servicenow: true,
      ado: true, // pat mode + ADO_PAT present
      rag: true, // runtimeFactory provided
    });
  });

  it("includes config-status in snapshot()", async () => {
    const events: ServerEvent[] = [];
    const host = makeFullHost(events);
    await host.start();
    expect(host.snapshot().some((e) => e.type === "config-status")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/web/tests/engine-host.test.ts`
Expected: FAIL — `config-status` is not a known event / not emitted.

- [ ] **Step 3: Add the event to the contract**

In `packages/web/shared/events.ts`, add a member to the `ServerEvent` union (before the final `engine-state` line is fine):

```ts
  | {
      type: "config-status";
      llmMode: "seat" | "byok";
      model: string;
      provider?: string;
      servicenow: boolean;
      ado: boolean;
      rag: boolean;
    }
```

- [ ] **Step 4: Derive + emit + snapshot in engine-host**

In `packages/web/server/engine-host.ts`:

a) Cache it alongside the other snapshot events. Add a third `let`:

```ts
  let lastEngineState: ServerEvent | undefined;
  let lastAuthStatus: ServerEvent | undefined;
  let lastConfigStatus: ServerEvent | undefined;
```

b) Extend the caching `emit` wrapper:

```ts
  const emit = (e: ServerEvent) => {
    if (e.type === "engine-state") lastEngineState = e;
    else if (e.type === "auth-status") lastAuthStatus = e;
    else if (e.type === "config-status") lastConfigStatus = e;
    baseEmit(e);
  };
```

c) Add a derivation helper (place after `engine`/`runtime` are declared, near `authStatus`):

```ts
  const emitConfigStatus = () => {
    const raw = config.raw as Record<string, string | undefined> | undefined;
    emit({
      type: "config-status",
      llmMode: config.llm.mode,
      model: config.llm.model,
      provider: config.llm.provider?.type,
      servicenow: !!raw?.SERVICENOW_BASE_URL,
      ado:
        config.adoAuthMode === "pat"
          ? !!raw?.ADO_PAT
          : !!(raw?.ADO_ORG_URL && raw?.ADO_PROJECT),
      rag: !!runtime,
    });
  };
```

d) Call it after the engine reaches `ready` in **both** `start()` and `restart()`. In `start()`:

```ts
    async start() {
      emit({ type: "engine-state", state: "starting" });
      await engine.start();
      emit({ type: "engine-state", state: "ready" });
      emitConfigStatus();
      await authStatus();
    },
```

And in `restart()`, after `emit({ type: "engine-state", state: "ready" });`:

```ts
    emit({ type: "engine-state", state: "ready" });
    emitConfigStatus();
    await authStatus();
```

e) Add it to `snapshot()`:

```ts
    snapshot(): ServerEvent[] {
      return [lastEngineState, lastAuthStatus, lastConfigStatus].filter(Boolean) as ServerEvent[];
    },
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run packages/web/tests/engine-host.test.ts`
Expected: PASS (all engine-host tests, including the two new ones).

- [ ] **Step 6: Typecheck the server build**

Run: `npm run build --workspace @sre/web`
Expected: no TypeScript errors.

- [ ] **Step 7: Commit**

```bash
git add packages/web/shared/events.ts packages/web/server/engine-host.ts packages/web/tests/engine-host.test.ts
git commit -m "feat(web): emit config-status event with config-derived integration flags"
```

---

### Task 2: Client reducer — `busy`, `activeTool`, `config`

**Files:**
- Modify: `packages/web/client/src/state.ts`
- Test: `packages/web/tests/state.test.ts`

**Interfaces:**
- Consumes: the `config-status` event from Task 1.
- Produces: `ChatState` now carries `busy: boolean`, `activeTool?: string`, and
  `config?: { llmMode: "seat" | "byok"; model: string; provider?: string; servicenow: boolean; ado: boolean; rag: boolean }`.
  Reducer rules: `user-message` sets `busy=true`; `tool-start` sets `activeTool`;
  `delta` clears `activeTool`; `turn-end`/`turn-error` clear `busy`+`activeTool`;
  `config-status` stores `config`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/web/tests/state.test.ts` (inside the `describe`):

```ts
  it("sets busy on user-message and clears it on turn-end", () => {
    let s = applyServerEvent(initialState, { type: "user-message", text: "hi" });
    expect(s.busy).toBe(true);
    s = applyServerEvent(s, { type: "turn-end" });
    expect(s.busy).toBe(false);
  });

  it("tracks the active tool and clears it on first delta", () => {
    let s = applyServerEvent(initialState, { type: "tool-start", name: "web_fetch" });
    expect(s.activeTool).toBe("web_fetch");
    s = applyServerEvent(s, { type: "delta", text: "x" });
    expect(s.activeTool).toBeUndefined();
  });

  it("clears busy and activeTool on turn-error", () => {
    let s = applyServerEvent(initialState, { type: "user-message", text: "hi" });
    s = applyServerEvent(s, { type: "tool-start", name: "t" });
    s = applyServerEvent(s, { type: "turn-error", message: "boom", isAuthError: false });
    expect(s.busy).toBe(false);
    expect(s.activeTool).toBeUndefined();
  });

  it("stores config from config-status", () => {
    const s = applyServerEvent(initialState, {
      type: "config-status",
      llmMode: "seat",
      model: "gpt-5",
      servicenow: true,
      ado: false,
      rag: true,
    });
    expect(s.config).toMatchObject({ llmMode: "seat", model: "gpt-5", servicenow: true, ado: false, rag: true });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/web/tests/state.test.ts`
Expected: FAIL — `busy`/`activeTool`/`config` undefined; reducer has no `config-status` case.

- [ ] **Step 3: Extend the state shape**

In `packages/web/client/src/state.ts`, update the interface and initial state:

```ts
export interface ChatState {
  messages: ChatMessage[];
  streaming: string;
  busy: boolean;
  activeTool?: string;
  engineState: EngineState;
  auth: { isAuthenticated: boolean; authType?: string; login?: string; ambientEnvWarning: boolean };
  config?: { llmMode: "seat" | "byok"; model: string; provider?: string; servicenow: boolean; ado: boolean; rag: boolean };
  deviceCode?: { verificationUri: string; userCode: string };
  confirm?: { id: string; summary: string };
  error?: { message: string; isAuthError: boolean };
  nextMessageId: number;
}

export const initialState: ChatState = {
  messages: [],
  streaming: "",
  busy: false,
  engineState: "starting",
  auth: { isAuthenticated: false, ambientEnvWarning: false },
  nextMessageId: 0,
};
```

- [ ] **Step 4: Update the reducer cases**

In the same file, modify these cases:

```ts
    case "user-message":
      return {
        ...s,
        busy: true,
        messages: [...s.messages, { id: s.nextMessageId, role: "user", text: e.text }],
        nextMessageId: s.nextMessageId + 1,
      };
    case "delta":
      return { ...s, streaming: s.streaming + e.text, activeTool: undefined };
    case "turn-end":
      return {
        ...s,
        busy: false,
        activeTool: undefined,
        messages: s.streaming
          ? [...s.messages, { id: s.nextMessageId, role: "assistant", text: s.streaming }]
          : s.messages,
        streaming: "",
        nextMessageId: s.streaming ? s.nextMessageId + 1 : s.nextMessageId,
      };
    case "turn-error":
      return { ...s, busy: false, activeTool: undefined, streaming: "", error: { message: e.message, isAuthError: e.isAuthError } };
    case "config-status":
      return {
        ...s,
        config: {
          llmMode: e.llmMode,
          model: e.model,
          provider: e.provider,
          servicenow: e.servicenow,
          ado: e.ado,
          rag: e.rag,
        },
      };
    case "tool-start":
      return { ...s, activeTool: e.name };
```

(Replace the existing `user-message`, `delta`, `turn-end`, `turn-error`, and `tool-start` cases; add the `config-status` case.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run packages/web/tests/state.test.ts`
Expected: PASS (existing + 4 new tests).

- [ ] **Step 6: Commit**

```bash
git add packages/web/client/src/state.ts packages/web/tests/state.test.ts
git commit -m "feat(web): reducer tracks busy/activeTool and stores config-status"
```

---

### Task 3: Markdown rendering + busy indicator in Chat

**Files:**
- Modify: `packages/web/client/package.json` (add deps)
- Create: `packages/web/client/src/views/Markdown.tsx`
- Modify: `packages/web/client/src/index.css` (one rule for code blocks)
- Modify: `packages/web/client/src/views/Chat.tsx`

**Interfaces:**
- Consumes: `ChatState.busy`, `ChatState.activeTool`, `ChatState.streaming` from Task 2.
- Produces: `<Markdown>{text}</Markdown>` component (default export not used; named `Markdown`).
- Note: no automated DOM test (the client has no jsdom/testing-library setup; the only client unit test is the pure reducer). Verification is build + design grep + live browser smoke, per the spec.

- [ ] **Step 1: Add dependencies**

Run:
```bash
npm install --workspace @sre/web/client react-markdown@^9 remark-gfm@^4
```
(If the client package name differs, install into `packages/web/client`: `npm install react-markdown@^9 remark-gfm@^4 --prefix packages/web/client` — verify with `grep '"react-markdown"' packages/web/client/package.json`.)
Expected: both appear under `dependencies` in `packages/web/client/package.json`.

- [ ] **Step 2: Create the Markdown component**

Create `packages/web/client/src/views/Markdown.tsx`:

```tsx
// packages/web/client/src/views/Markdown.tsx
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";

// Each element styled with ING semantic tokens only (design grep stays clean).
const components: Components = {
  h1: ({ children }) => <h1 className="text-headline-md mt-4 mb-2 first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="text-headline-md mt-4 mb-2 first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="text-label-md mt-3 mb-1">{children}</h3>,
  p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="list-disc pl-5 mb-2 space-y-1">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal pl-5 mb-2 space-y-1">{children}</ol>,
  li: ({ children }) => <li>{children}</li>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer" className="text-primary-container underline">{children}</a>
  ),
  code: ({ children, ...props }) => (
    <code {...props} className="rounded-sm bg-surface-container-high px-1 py-0.5 font-mono text-label-sm">{children}</code>
  ),
  pre: ({ children }) => (
    <pre className="rounded bg-surface-container-high p-3 my-2 overflow-x-auto">{children}</pre>
  ),
  table: ({ children }) => (
    <div className="overflow-x-auto my-2">
      <table className="w-full border-collapse text-body-md">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead>{children}</thead>,
  th: ({ children }) => <th className="border border-outline-variant px-3 py-1.5 text-left font-semibold bg-surface-container">{children}</th>,
  td: ({ children }) => <td className="border border-outline-variant px-3 py-1.5 align-top">{children}</td>,
};

export function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown text-body-md text-on-surface">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
```

- [ ] **Step 3: Neutralize nested code background**

Add to the end of `packages/web/client/src/index.css` (so block code inside `<pre>` doesn't get the inline-code chip styling):

```css
/* react-markdown: code inside a fenced block should not get the inline chip */
.markdown pre code {
  background: transparent;
  padding: 0;
}
```

- [ ] **Step 4: Render markdown + busy indicator in Chat**

Replace the message list section of `packages/web/client/src/views/Chat.tsx`. The assistant + streaming bubbles render through `<Markdown>` as block elements; user bubbles stay plain text; the busy indicator shows while waiting. Full file:

```tsx
// packages/web/client/src/views/Chat.tsx
import { useState } from "react";
import { abortTurn } from "../api.js";
import type { ChatState } from "../state.js";
import { Markdown } from "./Markdown.js";

export function Chat({ state, onSend }: { state: ChatState; onSend: (text: string) => void }) {
  const [input, setInput] = useState("");
  return (
    <div className="flex flex-col h-full max-w-container mx-auto w-full">
      <div className="flex-1 overflow-auto p-6 space-y-4">
        {state.messages.map((m) =>
          m.role === "user" ? (
            <div key={m.id} className="text-right">
              <span className="inline-block rounded px-4 py-2 text-body-md bg-primary-container text-on-primary whitespace-pre-wrap">
                {m.text}
              </span>
            </div>
          ) : (
            <div key={m.id} className="rounded px-4 py-2 bg-surface-container">
              <Markdown>{m.text}</Markdown>
            </div>
          ),
        )}
        {state.streaming && (
          <div className="rounded px-4 py-2 bg-surface-container">
            <Markdown>{state.streaming}</Markdown>
          </div>
        )}
        {state.busy && !state.streaming && (
          <div role="status" aria-live="polite" className="flex items-center gap-2 px-4 py-2 text-on-surface-variant text-label-md">
            <span className="flex gap-1" aria-hidden="true">
              <span className="h-1.5 w-1.5 rounded-full bg-on-surface-variant motion-safe:animate-bounce [animation-delay:-0.3s]" />
              <span className="h-1.5 w-1.5 rounded-full bg-on-surface-variant motion-safe:animate-bounce [animation-delay:-0.15s]" />
              <span className="h-1.5 w-1.5 rounded-full bg-on-surface-variant motion-safe:animate-bounce" />
            </span>
            {state.activeTool ? `Running ${state.activeTool}…` : "Thinking…"}
          </div>
        )}
        {state.error && (
          <div role="alert" className="text-label-md text-error">
            {state.error.message}
            {state.error.isAuthError && " — try signing in again."}
          </div>
        )}
      </div>
      <form
        className="p-4 border-t border-surface-gray flex gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (input.trim()) {
            onSend(input);
            setInput("");
          }
        }}
      >
        <input
          aria-label="Message"
          className="flex-1 border border-outline rounded px-3 py-2 text-body-md focus-visible:border-primary-container"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about incidents, changes, ADO work items…"
        />
        <button className="px-5 py-2 rounded bg-primary-container text-on-primary text-label-md" type="submit">
          Send
        </button>
        <button
          className="px-4 py-2 rounded border border-primary-container text-primary-container text-label-md"
          type="button"
          onClick={() => abortTurn()}
        >
          Stop
        </button>
      </form>
    </div>
  );
}
```

(Input stays local in this task; Task 4 lifts it to `App` for the workflow-insert wiring.)

- [ ] **Step 5: Build + design grep**

Run:
```bash
npm run build --workspace @sre/web
grep -rnE '(bg|text|border|ring)-(blue|gray|red|green|amber|slate|zinc|indigo|purple)-[0-9]' packages/web/client/src && echo FOUND || echo CLEAN
```
Expected: build succeeds; grep prints `CLEAN`.

- [ ] **Step 6: Commit**

```bash
git add packages/web/client/package.json packages/web/client/src/views/Markdown.tsx packages/web/client/src/index.css packages/web/client/src/views/Chat.tsx
git commit -m "feat(web): render assistant markdown (gfm tables) + thinking indicator"
```

---

### Task 4: Left sidebar + layout + success token

**Files:**
- Modify: `docs/DESIGN.md` (add green tokens)
- Modify: `packages/web/tailwind.config.js` (add green tokens)
- Create: `packages/web/client/src/views/Sidebar.tsx`
- Modify: `packages/web/client/src/App.tsx` (layout, lift input)
- Modify: `packages/web/client/src/views/Chat.tsx` (controlled input props)

**Interfaces:**
- Consumes: `ChatState.config` (Task 2), `ChatState.engineState`, `ChatState.auth`.
- Produces: `Sidebar({ state, tab, onTab, onInsert })`; `Chat` now takes `input: string` and `setInput: (v: string) => void` props instead of local state.

- [ ] **Step 1: Add the green tokens (DESIGN.md)**

In `docs/DESIGN.md`, under the colors list (after the `on-error-container` line), add:

```
  success: '#386a20'
  on-success: '#ffffff'
  success-container: '#b7f397'
  on-success-container: '#042100'
```

- [ ] **Step 2: Add the green tokens (tailwind config)**

In `packages/web/tailwind.config.js`, inside `colors`, after the `"on-error-container"` line:

```js
        success: "#386a20",
        "on-success": "#ffffff",
        "success-container": "#b7f397",
        "on-success-container": "#042100",
```

- [ ] **Step 3: Create the Sidebar**

Create `packages/web/client/src/views/Sidebar.tsx`:

```tsx
// packages/web/client/src/views/Sidebar.tsx
import type { ChatState } from "../state.js";

const WORKFLOWS = ["/triage", "/review", "/postmortem", "/handover"];

function Dot({ on }: { on: boolean }) {
  return <span className={"h-2 w-2 rounded-full shrink-0 " + (on ? "bg-success" : "bg-outline-variant")} aria-hidden="true" />;
}

function Row({ label, on }: { label: string; on: boolean }) {
  return (
    <div className="flex items-center gap-2 text-label-md text-on-surface">
      <Dot on={on} />
      <span className="truncate">{label}</span>
    </div>
  );
}

export function Sidebar({
  state,
  tab,
  onTab,
  onInsert,
}: {
  state: ChatState;
  tab: "chat" | "settings";
  onTab: (t: "chat" | "settings") => void;
  onInsert: (text: string) => void;
}) {
  const c = state.config;
  const llmLabel = c ? `${c.llmMode === "seat" ? "Copilot" : c.provider ?? "BYOK"} · ${c.model}` : "LLM";
  return (
    <aside className="w-64 shrink-0 h-full flex flex-col gap-6 border-r border-surface-gray bg-surface-container-lowest px-4 py-4 overflow-y-auto">
      <strong className="text-label-md text-primary-container">SRE Agent</strong>

      <nav className="flex flex-col gap-1 text-label-md">
        <button
          onClick={() => onTab("chat")}
          className={"text-left px-2 py-1 rounded " + (tab === "chat" ? "bg-surface-container text-primary-container" : "text-on-surface-variant")}
        >
          Chat
        </button>
        <button
          onClick={() => onTab("settings")}
          className={"text-left px-2 py-1 rounded " + (tab === "settings" ? "bg-surface-container text-primary-container" : "text-on-surface-variant")}
        >
          Settings
        </button>
      </nav>

      <section className="flex flex-col gap-2">
        <h2 className="text-label-sm text-on-surface-variant uppercase tracking-wide">Integrations</h2>
        <Row label="ServiceNow" on={!!c?.servicenow} />
        <Row label="Azure Boards" on={!!c?.ado} />
        <Row label={llmLabel} on={!!c} />
        <Row label="RAG" on={!!c?.rag} />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-label-sm text-on-surface-variant uppercase tracking-wide">Workflows</h2>
        {WORKFLOWS.map((w) => (
          <button
            key={w}
            onClick={() => onInsert(w + " ")}
            className="text-left px-2 py-1 rounded font-mono text-label-sm text-on-surface hover:bg-surface-container"
          >
            {w}
          </button>
        ))}
      </section>

      <div className="mt-auto text-label-sm text-on-surface-variant">
        {state.engineState}
        {state.auth.login ? ` · ${state.auth.login}` : ""}
      </div>
    </aside>
  );
}
```

- [ ] **Step 4: Rewrite App layout + lift input**

Replace `packages/web/client/src/App.tsx`:

```tsx
// packages/web/client/src/App.tsx
import { useState } from "react";
import { useServerStream } from "./sse.js";
import { Chat } from "./views/Chat.js";
import { Login } from "./views/Login.js";
import { ConfirmDialog } from "./views/ConfirmDialog.js";
import { EnvSettings } from "./views/EnvSettings.js";
import { Sidebar } from "./views/Sidebar.js";

export function App() {
  const { state, connected, send } = useServerStream();
  const [tab, setTab] = useState<"chat" | "settings">("chat");
  const [input, setInput] = useState("");

  if (!state.auth.isAuthenticated) {
    return (
      <div className="h-screen flex flex-col bg-background">
        <Login deviceCode={state.deviceCode} />
        {state.confirm && <ConfirmDialog confirm={state.confirm} />}
      </div>
    );
  }

  return (
    <div className="h-screen flex bg-background">
      <Sidebar state={state} tab={tab} onTab={setTab} onInsert={setInput} />
      <div className="flex-1 flex flex-col overflow-hidden">
        {!connected && (
          <div role="status" className="bg-surface-container text-on-surface-variant text-label-sm px-6 py-1">
            Reconnecting…
          </div>
        )}
        {state.auth.ambientEnvWarning && (
          <div role="alert" className="bg-error-container text-on-error-container text-label-md px-6 py-2">
            Warning: an ambient env token resolved — if turns 403, unset GH_TOKEN/GITHUB_TOKEN or set COPILOT_GITHUB_TOKEN.
          </div>
        )}
        <main className="flex-1 overflow-hidden">
          {tab === "chat" ? (
            <Chat state={state} onSend={send} input={input} setInput={setInput} />
          ) : (
            <EnvSettings />
          )}
        </main>
      </div>
      {state.confirm && <ConfirmDialog confirm={state.confirm} />}
    </div>
  );
}
```

- [ ] **Step 5: Make Chat input controlled**

In `packages/web/client/src/views/Chat.tsx`: remove the local `useState` for input and accept it via props. Change the signature and delete the `useState` line:

```tsx
import { abortTurn } from "../api.js";
import type { ChatState } from "../state.js";
import { Markdown } from "./Markdown.js";

export function Chat({
  state,
  onSend,
  input,
  setInput,
}: {
  state: ChatState;
  onSend: (text: string) => void;
  input: string;
  setInput: (v: string) => void;
}) {
```

(Remove `import { useState } from "react";` and the `const [input, setInput] = useState("");` line. The rest of the file — message list, busy indicator, form using `input`/`setInput` — is unchanged from Task 3.)

- [ ] **Step 6: Build + design grep**

Run:
```bash
npm run build --workspace @sre/web
grep -rnE '(bg|text|border|ring)-(blue|gray|red|green|amber|slate|zinc|indigo|purple)-[0-9]' packages/web/client/src && echo FOUND || echo CLEAN
```
Expected: build succeeds; grep prints `CLEAN` (`bg-success` / `bg-outline-variant` are named tokens — no digit — so they don't match).

- [ ] **Step 7: Full suite**

Run: `npm test`
Expected: all tests pass (prior count + the new reducer/host tests).

- [ ] **Step 8: Commit**

```bash
git add docs/DESIGN.md packages/web/tailwind.config.js packages/web/client/src/views/Sidebar.tsx packages/web/client/src/App.tsx packages/web/client/src/views/Chat.tsx
git commit -m "feat(web): left sidebar with integration status + clickable workflows; success token"
```

---

### Task 5: Live browser smoke (manual, documented)

**Files:** none (verification only).

- [ ] **Step 1: Build and start**

```bash
npm run build
npm start --workspace @sre/web
```
Open `http://127.0.0.1:4317`.

- [ ] **Step 2: Verify**

- Sidebar shows on the left (no top bar) once authenticated: brand, Chat/Settings nav, Integrations with dots (ServiceNow/Azure Boards/LLM `Copilot · gpt-5`/RAG — green when configured), Workflows list.
- Click `/triage` → input fills with `/triage `.
- Send a prompt → a "Thinking…" three-dot indicator shows; if a tool runs, it reads `Running <tool>…`.
- Assistant reply renders as formatted markdown — paragraphs spaced, a GFM table renders as a real bordered table (not `|` text).
- Console is clean.

- [ ] **Step 3: Stop**

```bash
pkill -f dist/server/index.js
```

---

## Self-Review

**Spec coverage:**
- Markdown rendering incl. tables → Task 3 (Markdown.tsx + Chat). ✓
- Busy/thinking + tool surfacing → Task 2 (state) + Task 3 (indicator). ✓
- Sidebar replacing top bar, integration dots, model label, clickable workflows → Task 1 (event) + Task 2 (config) + Task 4 (Sidebar/App). ✓
- `success` green token + DESIGN.md → Task 4. ✓
- No-emoji dots, reduced-motion animation, design grep → enforced in Tasks 3 & 4 steps. ✓
- config-status in snapshot (new SSE clients get dots) → Task 1. ✓

**Placeholder scan:** none — every step has concrete code/commands.

**Type consistency:** `config-status` shape identical across events.ts (Task 1), reducer (Task 2), and Sidebar consumption (Task 4): `{ llmMode, model, provider?, servicenow, ado, rag }`. `Chat` prop change (`input`/`setInput`) defined in Task 4 matches the `App` wiring in the same task. `emitConfigStatus` / `lastConfigStatus` names consistent within Task 1.
