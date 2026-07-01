// packages/web/client/src/views/Chat.tsx
import { useEffect, useRef } from "react";
import { abortTurn } from "../api.js";
import type { ChatState } from "../state.js";
import { Markdown } from "./Markdown.js";
import { Button } from "./ui/Button.js";

const svgProps = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

const PROMPTS = [
  {
    text: "Show me the latest 5 incidents",
    icon: (
      <svg viewBox="0 0 20 20" className="h-5 w-5" {...svgProps}>
        <path d="M4 6h12M4 10h12M4 14h8" />
      </svg>
    ),
  },
  {
    text: "Triage open P1 incidents",
    icon: (
      <svg viewBox="0 0 20 20" className="h-5 w-5" {...svgProps}>
        <path d="M10 3.5 17.5 16.5H2.5z" />
        <path d="M10 8.5v3M10 14.2h.01" />
      </svg>
    ),
  },
  {
    text: "Summarize current SLA risk",
    icon: (
      <svg viewBox="0 0 20 20" className="h-5 w-5" {...svgProps}>
        <circle cx="10" cy="10" r="6.5" />
        <path d="M10 6v4l2.5 1.5" />
      </svg>
    ),
  },
  {
    text: "What changed before INC0010023?",
    icon: (
      <svg viewBox="0 0 20 20" className="h-5 w-5" {...svgProps}>
        <path d="M4 10a6 6 0 1 0 1.9-4.4" />
        <path d="M3.5 4v3h3" />
      </svg>
    ),
  },
];

function Welcome({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="h-full flex flex-col items-center justify-start pt-[12vh] text-center gap-7 px-6">
      <div className="flex flex-col items-center gap-3">
        <p className="text-label-sm uppercase tracking-[0.2em] text-primary-container">Site Reliability Copilot</p>
        <h2 className="font-display font-bold text-display-lg tracking-tight text-balance text-on-surface">
          Welcome to <span className="text-primary-container">SRE Agent</span>
        </h2>
        <p className="text-body-lg text-on-surface-variant max-w-xl text-pretty">
          Ask about incidents, changes, SLA risk, and ADO work items.
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5 w-full max-w-2xl">
        {PROMPTS.map((p) => (
          <button
            key={p.text}
            type="button"
            onClick={() => onPick(p.text)}
            className="group flex items-center gap-3 text-left bg-surface-container-lowest border border-surface-gray rounded-xl px-4 py-3.5 text-body-md text-on-surface shadow-sm transition hover:-translate-y-0.5 hover:border-primary-container hover:shadow-ambient"
          >
            <span aria-hidden="true" className="grid place-items-center h-9 w-9 shrink-0 rounded-lg bg-primary-container/10 text-primary-container">
              {p.icon}
            </span>
            <span className="flex-1 min-w-0">{p.text}</span>
            <span
              aria-hidden="true"
              className="shrink-0 text-primary-container opacity-0 -translate-x-1 transition group-hover:opacity-100 group-hover:translate-x-0"
            >
              →
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

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
  const empty =
    state.messages.length === 0 && !state.streaming && !state.busy && !state.error;
  const scrollRef = useRef<HTMLDivElement>(null);
  // ponytail: always pin to bottom on new content. If users complain about
  // being yanked down while reading scrollback, gate on "already near bottom".
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.messages.length, state.streaming, state.busy]);
  return (
    <div className="flex flex-col h-full max-w-container mx-auto w-full">
      <div ref={scrollRef} className="flex-1 overflow-auto p-6 space-y-4">
        {empty ? (
          <Welcome onPick={setInput} />
        ) : (
          <>
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
          </>
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
        <textarea
          aria-label="Message"
          name="message"
          autoComplete="off"
          rows={1}
          className="flex-1 resize-none min-h-[44px] max-h-[200px] border border-outline rounded px-3 py-2 text-body-md focus-visible:border-primary-container"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter inserts a newline. Ignore Enter while an
            // IME composition is active so it commits text instead of sending.
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder="Ask about incidents, changes, ADO work items… (Shift+Enter for new line)"
        />
        <Button type="submit">Send</Button>
        <Button variant="outline" onClick={() => abortTurn()}>
          Stop
        </Button>
      </form>
    </div>
  );
}
