import { cn } from "@band-app/ui";
import type React from "react";

/**
 * The sidebar's repos: a header with the count and `actions` (label filter, Collapse all), above a
 * scrolling list that fills the column.
 */
export function ReposPanel({
  count,
  actions,
  onListClick,
  tall,
  children,
}: {
  count: number | null;
  actions?: React.ReactNode;
  onListClick?: (e: React.MouseEvent<HTMLDivElement>) => void;
  /** Make the header as tall as the mobile worktree header, so the two line up. */
  tall?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="flex min-h-0 flex-1 flex-col" data-testid="repos-panel" aria-label="Repos">
      <div
        data-testid="repos-panel__header"
        className={cn("flex shrink-0 items-center gap-1 pr-2 pl-4", tall ? "h-12" : "h-7")}
      >
        <div className="flex h-full min-w-0 flex-1 items-center gap-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          <span>Repos</span>
          {count !== null && (
            <span className="text-[10px] font-medium tabular-nums" data-testid="repos-panel__count">
              {count}
            </span>
          )}
        </div>
        {actions}
      </div>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the list itself handles the keys */}
      <div
        className="min-h-0 flex-1 overflow-y-auto pb-3"
        data-testid="repos-panel__list"
        onClick={onListClick}
      >
        {children}
      </div>
    </section>
  );
}
