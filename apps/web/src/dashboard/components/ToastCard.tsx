import { X } from "lucide-react";
import type { ReactNode } from "react";

/**
 * One card in the bottom-right toast stack (`ToastHost`). The host owns the
 * position; a card only draws itself, with an optional close button in its
 * top-right corner.
 */
export function ToastCard({
  testId,
  onClose,
  children,
}: {
  testId: string;
  onClose?: () => void;
  children: ReactNode;
}) {
  return (
    <output
      aria-live="polite"
      data-testid={testId}
      className="pointer-events-auto relative block rounded-lg border bg-popover p-3 text-sm text-popover-foreground shadow-lg animate-in fade-in-0 slide-in-from-bottom-2 duration-200"
    >
      {onClose && (
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="absolute top-2 right-2 rounded-sm p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <X className="size-3.5" />
        </button>
      )}
      {children}
    </output>
  );
}
