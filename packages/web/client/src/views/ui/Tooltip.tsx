import { useId, useState } from "react";

// An accessible (i) info icon with a hover/focus popover. No dependency: the
// icon is an inline SVG, visibility is state-driven, and the popover is linked
// via aria-describedby so screen readers announce it. Renders nothing when there
// is no text to show.
export function Tooltip({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (!text) return null;
  return (
    <span className="relative inline-flex shrink-0">
      <button
        type="button"
        aria-label="More information"
        aria-describedby={open ? id : undefined}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className="grid place-items-center h-5 w-5 rounded-full border border-outline text-on-surface-variant hover:text-primary-container hover:border-primary-container focus-visible:border-primary-container transition-colors"
      >
        <svg viewBox="0 0 20 20" className="h-3 w-3" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
          <circle cx="10" cy="10" r="7.5" />
          <path d="M10 9.2v4M10 6.6h.01" />
        </svg>
      </button>
      {open && (
        <span
          role="tooltip"
          id={id}
          className="absolute z-20 left-7 top-1/2 -translate-y-1/2 w-64 rounded-lg border border-surface-gray bg-surface-container-high text-on-surface text-label-md shadow-ambient px-3 py-2 text-pretty"
        >
          {text}
        </span>
      )}
    </span>
  );
}
