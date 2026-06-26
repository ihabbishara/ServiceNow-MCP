// packages/web/client/src/views/Chat.tsx
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
