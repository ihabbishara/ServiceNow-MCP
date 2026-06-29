// packages/web/client/src/views/ui/Button.tsx
import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "outline" | "ghost";
type Size = "md" | "sm";

// Encodes the two button patterns that were repeated inline across the views
// (primary fill + outline) plus a ghost for low-emphasis actions. Native button
// attributes (type, onClick, disabled, aria-*) pass straight through via ...rest.
const VARIANTS: Record<Variant, string> = {
  primary:
    "bg-primary-container text-on-primary hover:brightness-95 active:brightness-90 disabled:opacity-50 disabled:pointer-events-none",
  outline:
    "border border-primary-container text-primary-container hover:bg-primary-container/10 active:bg-primary-container/20 disabled:opacity-50 disabled:pointer-events-none",
  ghost:
    "text-on-surface-variant hover:bg-surface-container active:bg-surface-container-high disabled:opacity-50 disabled:pointer-events-none",
};

const SIZES: Record<Size, string> = {
  md: "px-5 py-2 text-label-md",
  sm: "px-3 py-1.5 text-label-sm",
};

export function Button({
  variant = "primary",
  size = "md",
  className = "",
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return (
    <button
      type={type}
      className={`rounded inline-flex items-center justify-center gap-2 transition-colors ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
      {...rest}
    />
  );
}
