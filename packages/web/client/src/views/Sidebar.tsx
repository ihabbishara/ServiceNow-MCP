// packages/web/client/src/views/Sidebar.tsx
import type { ChatState } from "../state.js";
import { CollapsibleSection } from "./ui/CollapsibleSection.js";
import ingLogo from "../assets/ing-logo.svg";

const WORKFLOWS = ["/triage", "/review", "/postmortem", "/handover"];

function Dot({ on }: { on: boolean }) {
  return (
    <span
      className={"h-2 w-2 rounded-full shrink-0 " + (on ? "bg-success" : "bg-outline-variant")}
      aria-hidden="true"
    />
  );
}

// Dots are config-derived: green = configured (credentials/runtime present), not a
// live reachability check. The tooltip says so to avoid reading green as "online".
function Row({ label, on }: { label: string; on: boolean }) {
  return (
    <div
      className="flex items-center gap-2 text-label-md text-on-surface"
      title={on ? "Configured" : "Not configured"}
    >
      <Dot on={on} />
      <span className="truncate">{label}</span>
    </div>
  );
}

export function Sidebar({
  state,
  tab,
  onTab,
  onInsert
}: {
  state: ChatState;
  tab: "chat" | "settings" | "sources";
  onTab: (t: "chat" | "settings" | "sources") => void;
  onInsert: (text: string) => void;
}) {
  const c = state.config;
  const llmLabel = c
    ? `${c.llmMode === "seat" ? "Copilot" : (c.provider ?? "BYOK")} · ${c.model}`
    : "LLM";
  return (
    <aside className="w-64 shrink-0 h-full flex flex-col gap-6 border-r border-surface-gray bg-surface-container-lowest px-4 py-5 overflow-y-auto">
      <header className="flex flex-col gap-3 pb-1">
        <img src={ingLogo} alt="ING" width={96} height={28} className="h-7 w-auto self-start" />
        <h1 className="font-display font-bold text-headline-md tracking-tight text-on-surface">
          SRE <span className="text-primary-container">Agent</span>
        </h1>
        <hr className="border-surface-gray" />
      </header>

      <nav className="flex flex-col gap-1 text-label-md">
        <button
          onClick={() => onTab("chat")}
          aria-current={tab === "chat" ? "page" : undefined}
          className={
            "text-left px-2 py-1.5 rounded transition-colors " +
            (tab === "chat"
              ? "bg-surface-container text-primary-container"
              : "text-on-surface-variant hover:bg-surface-container")
          }
        >
          Chat
        </button>
        <button
          onClick={() => onTab("sources")}
          aria-current={tab === "sources" ? "page" : undefined}
          className={
            "text-left px-2 py-1.5 rounded transition-colors " +
            (tab === "sources"
              ? "bg-surface-container text-primary-container"
              : "text-on-surface-variant hover:bg-surface-container")
          }
        >
          Sources
        </button>
        <button
          onClick={() => onTab("settings")}
          aria-current={tab === "settings" ? "page" : undefined}
          className={
            "text-left px-2 py-1.5 rounded transition-colors " +
            (tab === "settings"
              ? "bg-surface-container text-primary-container"
              : "text-on-surface-variant hover:bg-surface-container")
          }
        >
          Settings
        </button>
      </nav>

      <CollapsibleSection title="Integrations">
        <Row label="ServiceNow" on={!!c?.servicenow} />
        <Row label="Azure Boards" on={!!c?.ado} />
        <Row label={llmLabel} on={!!c} />
        <Row label="RAG" on={!!c?.rag} />
      </CollapsibleSection>

      <CollapsibleSection title="Workflows">
        {WORKFLOWS.map((w) => (
          <button
            key={w}
            onClick={() => onInsert(w + " ")}
            className="text-left px-2 py-1 rounded font-mono text-label-sm text-on-surface hover:bg-surface-container transition-colors"
          >
            {w}
          </button>
        ))}
      </CollapsibleSection>

      <div className="mt-auto text-label-sm text-on-surface-variant">
        {state.engineState}
        {state.auth.login ? ` · ${state.auth.login}` : ""}
      </div>
    </aside>
  );
}
