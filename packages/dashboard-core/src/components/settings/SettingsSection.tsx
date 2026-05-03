import { cn } from "@band-app/ui";
import type { ReactNode } from "react";

interface SettingsSectionProps {
  /** Header text displayed above the card (e.g. "General"). */
  title?: ReactNode;
  /** Optional supporting copy rendered between the title and the card. */
  description?: ReactNode;
  /** Optional trailing element rendered alongside the title (e.g. a Save button). */
  action?: ReactNode;
  /** Rows belonging to this section. They are rendered inside a single card with auto dividers. */
  children: ReactNode;
  className?: string;
}

/**
 * Section primitive matching the Codex-style settings reference: a muted
 * section title above a single rounded card whose direct children are
 * separated by 1px dividers.
 */
export function SettingsSection({
  title,
  description,
  action,
  children,
  className,
}: SettingsSectionProps) {
  return (
    <section className={cn("space-y-2", className)}>
      {(title || action) && (
        <div className="flex items-center justify-between gap-2 px-1">
          {title ? <h3 className="text-sm font-medium text-foreground/90">{title}</h3> : <span />}
          {action ? <div className="shrink-0">{action}</div> : null}
        </div>
      )}
      {description ? <p className="px-1 text-xs text-muted-foreground">{description}</p> : null}
      <div
        data-slot="settings-section-card"
        className={cn(
          "overflow-hidden rounded-xl border border-border bg-card",
          // Auto-divider between direct children (rows). Skips border-bottom of last child.
          "[&>*+*]:border-t [&>*+*]:border-border",
        )}
      >
        {children}
      </div>
    </section>
  );
}
