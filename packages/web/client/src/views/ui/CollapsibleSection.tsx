// packages/web/client/src/views/ui/CollapsibleSection.tsx
import { useId, useState, type ReactNode } from "react";

// A sidebar group whose children collapse under a clickable header. No icon lib:
// the chevron is an inline SVG that rotates 90° when open (motion is disabled
// globally under prefers-reduced-motion via index.css). Accessible: the header
// is a real button with aria-expanded + aria-controls pointing at the region.
export function CollapsibleSection({
  title,
  defaultOpen = true,
  children
}: {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const regionId = useId();
  return (
    <section className="flex flex-col gap-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={regionId}
        className="flex items-center gap-1.5 text-left text-label-sm text-on-surface-variant uppercase tracking-wide rounded px-1 py-1 hover:text-on-surface hover:bg-surface-container transition-colors"
      >
        <svg
          viewBox="0 0 20 20"
          aria-hidden="true"
          className={"h-3.5 w-3.5 shrink-0 transition-transform " + (open ? "rotate-90" : "")}
        >
          <path
            d="M7 5l6 5-6 5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        {title}
      </button>
      {open && (
        <div id={regionId} className="flex flex-col gap-2 pl-1">
          {children}
        </div>
      )}
    </section>
  );
}
