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
