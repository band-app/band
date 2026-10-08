import { ChevronDown, ChevronRight } from "lucide-react";
import type React from "react";
import { useCallback, useRef, useState } from "react";
import { clientStorage } from "../../lib/client-state";

const COLLAPSED_KEY = "band:repos-panel-collapsed";
const HEIGHT_KEY = "band:repos-panel-height";
const DEFAULT_HEIGHT = 320;
const MIN_HEIGHT = 96;
const MAX_HEIGHT = 900;

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    clientStorage.setItem(key, value);
  } catch {}
}

function clampHeight(h: number): number {
  return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(h)));
}

/**
 * The sidebar's repos, below the projects, in a panel that collapses to its header and resizes
 * from its top edge, like the Commits panel under Changes. Both states persist per device type.
 * `actions` sit at the right of the header (label filter, Collapse all).
 */
export function ReposPanel({
  count,
  actions,
  onListClick,
  children,
}: {
  count: number | null;
  actions?: React.ReactNode;
  onListClick?: (e: React.MouseEvent<HTMLDivElement>) => void;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(() => readStorage(COLLAPSED_KEY) === "true");
  const [height, setHeight] = useState(() => {
    const stored = Number(readStorage(HEIGHT_KEY));
    return stored > 0 ? clampHeight(stored) : DEFAULT_HEIGHT;
  });

  const toggleCollapsed = useCallback(() => {
    setCollapsed((c) => {
      writeStorage(COLLAPSED_KEY, String(!c));
      return !c;
    });
  }, []);

  // Drag the top edge to resize; the height persists across reloads. The handle captures the
  // pointer, so the drag ends on pointerup, pointercancel or unmount without listeners on window.
  const drag = useRef<{ startY: number; startHeight: number; latest: number } | null>(null);
  const startResize = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { startY: e.clientY, startHeight: height, latest: height };
    },
    [height],
  );
  const moveResize = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    d.latest = clampHeight(d.startHeight + d.startY - e.clientY);
    setHeight(d.latest);
  }, []);
  const endResize = useCallback(() => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    writeStorage(HEIGHT_KEY, String(d.latest));
  }, []);

  const Chevron = collapsed ? ChevronRight : ChevronDown;
  return (
    <section
      // Shrinks when the column is short (a small window, a zoomed app), so the bar below it stays
      // on screen; the list scrolls inside it.
      className="relative flex min-h-7 shrink flex-col border-t border-border"
      data-testid="repos-panel"
      data-collapsed={collapsed}
      aria-label="Repos"
    >
      {!collapsed && (
        <div
          className="absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize touch-none"
          onPointerDown={startResize}
          onPointerMove={moveResize}
          onLostPointerCapture={endResize}
          data-testid="repos-panel__resize"
        />
      )}
      <div className="flex h-7 shrink-0 items-center gap-1 pr-2 pl-1">
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-expanded={!collapsed}
          data-testid="repos-panel__toggle"
          className="flex h-full min-w-0 flex-1 items-center gap-1 text-left text-[11px] font-semibold tracking-wide text-muted-foreground uppercase"
        >
          <Chevron className="size-3.5 shrink-0" />
          <span>Repos</span>
          {count !== null && (
            <span className="text-[10px] font-medium tabular-nums" data-testid="repos-panel__count">
              {count}
            </span>
          )}
        </button>
        {collapsed ? null : actions}
      </div>
      {!collapsed && (
        // biome-ignore lint/a11y/useKeyWithClickEvents: the list itself handles the keys
        <div
          className="min-h-0 shrink overflow-y-auto pb-3"
          style={{ height: `min(${height}px, 60vh)` }}
          data-testid="repos-panel__list"
          onClick={onListClick}
        >
          {children}
        </div>
      )}
    </section>
  );
}
