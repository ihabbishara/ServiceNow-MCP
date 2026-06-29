// packages/web/client/src/views/ui/Card.tsx
import type { HTMLAttributes } from "react";

// The bordered surface panel repeated across Login / EnvSettings / ConfirmDialog.
// `floating` adds the soft ambient shadow (DESIGN.md: floating elements only).
export function Card({
  floating = false,
  className = "",
  ...rest
}: HTMLAttributes<HTMLDivElement> & { floating?: boolean }) {
  return (
    <div
      className={`bg-surface-container-lowest border border-surface-gray rounded-lg ${floating ? "shadow-ambient" : ""} ${className}`}
      {...rest}
    />
  );
}
