// packages/web/client/src/App.tsx
import { useState } from "react";
import { useServerStream } from "./sse.js";
import { Chat } from "./views/Chat.js";
import { Login } from "./views/Login.js";
import { ConfirmDialog } from "./views/ConfirmDialog.js";
import { EnvSettings } from "./views/EnvSettings.js";

export function App() {
  const { state, connected } = useServerStream();
  const [tab, setTab] = useState<"chat" | "settings">("chat");
  return (
    <div className="h-screen flex flex-col bg-background">
      <header className="flex items-center gap-6 px-6 py-3 border-b border-surface-gray bg-surface-container-lowest">
        <strong className="text-label-md text-primary-container">SRE Agent</strong>
        {state.auth.isAuthenticated && (
          <nav className="flex gap-4 text-label-md">
            <button
              onClick={() => setTab("chat")}
              className={tab === "chat" ? "text-primary-container" : "text-on-surface-variant"}
            >
              Chat
            </button>
            <button
              onClick={() => setTab("settings")}
              className={tab === "settings" ? "text-primary-container" : "text-on-surface-variant"}
            >
              Settings
            </button>
          </nav>
        )}
        <span className="ml-auto text-label-sm text-on-surface-variant">
          {state.engineState}
          {state.auth.login ? ` · ${state.auth.login}` : ""}
        </span>
      </header>
      {!connected && (
        <div role="status" className="bg-surface-container text-on-surface-variant text-label-sm px-6 py-1">Reconnecting…</div>
      )}
      {state.auth.ambientEnvWarning && (
        <div role="alert" className="bg-error-container text-on-error-container text-label-md px-6 py-2">
          Warning: an ambient env token resolved — if turns 403, unset GH_TOKEN/GITHUB_TOKEN or set COPILOT_GITHUB_TOKEN.
        </div>
      )}
      <main className="flex-1 overflow-hidden">
        {!state.auth.isAuthenticated ? (
          <Login deviceCode={state.deviceCode} />
        ) : tab === "chat" ? (
          <Chat state={state} />
        ) : (
          <EnvSettings />
        )}
      </main>
      {state.confirm && <ConfirmDialog confirm={state.confirm} />}
    </div>
  );
}
