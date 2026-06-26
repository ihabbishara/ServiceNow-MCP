// packages/web/client/src/views/Chat.tsx
import { useState } from "react";
import { abortTurn } from "../api.js";
import type { ChatState } from "../state.js";
export function Chat({ state, onSend }: { state: ChatState; onSend: (text: string) => void }) {
  const [input, setInput] = useState("");
  return (
    <div className="flex flex-col h-full max-w-container mx-auto w-full">
      <div className="flex-1 overflow-auto p-6 space-y-4">
        {state.messages.map((m) => (
          <div key={m.id} className={m.role === "user" ? "text-right" : ""}>
            <span
              className={
                "inline-block rounded px-4 py-2 text-body-md " +
                (m.role === "user"
                  ? "bg-primary-container text-on-primary"
                  : "bg-surface-container text-on-surface")
              }
            >
              {m.text}
            </span>
          </div>
        ))}
        {state.streaming && (
          <div>
            <span className="inline-block rounded px-4 py-2 text-body-md bg-surface-container text-on-surface">
              {state.streaming}
            </span>
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
