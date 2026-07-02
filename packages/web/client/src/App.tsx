// packages/web/client/src/App.tsx
import { useState } from "react";
import { useServerStream } from "./sse.js";
import { Chat } from "./views/Chat.js";
import { Login } from "./views/Login.js";
import { ConfirmDialog } from "./views/ConfirmDialog.js";
import { EnvSettings } from "./views/EnvSettings.js";
import { Sidebar } from "./views/Sidebar.js";
import { Sources } from "./views/Sources.js";

export function App() {
  const { state, connected, send } = useServerStream();
  const [tab, setTab] = useState<"chat" | "settings" | "sources">("chat");
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
          <div
            role="status"
            className="bg-surface-container text-on-surface-variant text-label-sm px-6 py-1"
          >
            Reconnecting…
          </div>
        )}
        {state.auth.ambientEnvWarning && (
          <div
            role="alert"
            className="bg-error-container text-on-error-container text-label-md px-6 py-2"
          >
            Warning: an ambient env token resolved — if turns 403, unset GH_TOKEN/GITHUB_TOKEN or
            set COPILOT_GITHUB_TOKEN.
          </div>
        )}
        <main className="flex-1 overflow-hidden">
          {tab === "chat" ? (
            <Chat state={state} onSend={send} input={input} setInput={setInput} />
          ) : tab === "sources" ? (
            <Sources state={state} />
          ) : (
            <EnvSettings />
          )}
        </main>
      </div>
      {state.confirm && <ConfirmDialog confirm={state.confirm} />}
    </div>
  );
}
