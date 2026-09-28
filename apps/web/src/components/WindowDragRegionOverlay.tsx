import { useEffect, useState } from "react";
import { type DragRegionSnapshot, snapshotDragRegion } from "../lib/drag-region";

// Developer aid for "a click on a tab dragged the window": draws the window
// drag region the renderer computes (`lib/drag-region.ts`) over the app, so a
// spot where clicks fail can be compared with it. Red boxes drag the window,
// green boxes are cut out of the region, and yellow outlines mark top-row
// controls a drag box covers. Toggled from the command palette ("Toggle Window
// Drag Region Overlay"); the choice stays on this device.

const DRAG_REGION_OVERLAY_KEY = "band.debug.drag-region-overlay";
// sync-with: the "toggle-drag-region-overlay" command in dashboard/lib/command-registry.ts
const TOGGLE_DRAG_REGION_OVERLAY_EVENT = "band:toggle-drag-region-overlay";

const REFRESH_MS = 500;

function loadEnabled(): boolean {
  try {
    return localStorage.getItem(DRAG_REGION_OVERLAY_KEY) === "1";
  } catch {
    return false;
  }
}

export function WindowDragRegionOverlay() {
  const [enabled, setEnabled] = useState(loadEnabled);
  const [snapshot, setSnapshot] = useState<DragRegionSnapshot | null>(null);

  useEffect(() => {
    const toggle = () => setEnabled((prev) => !prev);
    window.addEventListener(TOGGLE_DRAG_REGION_OVERLAY_EVENT, toggle);
    return () => window.removeEventListener(TOGGLE_DRAG_REGION_OVERLAY_EVENT, toggle);
  }, []);

  useEffect(() => {
    try {
      if (enabled) localStorage.setItem(DRAG_REGION_OVERLAY_KEY, "1");
      else localStorage.removeItem(DRAG_REGION_OVERLAY_KEY);
    } catch {}
    if (!enabled) {
      setSnapshot(null);
      return;
    }
    // Polled, not observed: the region changes with layout, scroll and style
    // changes that no single observer reports.
    const refresh = () => setSnapshot(snapshotDragRegion());
    refresh();
    const timer = window.setInterval(refresh, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [enabled]);

  if (!enabled || !snapshot) return null;
  const dragCount = snapshot.rects.filter((r) => r.drag).length;
  return (
    <div
      data-testid="drag-region-overlay"
      className="pointer-events-none fixed inset-0 z-[2147483647]"
      // getBoundingClientRect() is in zoomed pixels; undo the <html> zoom so
      // the inline positions below apply 1:1 (sync-with: ZOOM_CSS_VAR).
      style={{ zoom: "calc(1 / var(--app-zoom, 1))" }}
      aria-hidden="true"
    >
      {snapshot.rects.map((r, i) => (
        <div
          // Rects have no identity across refreshes; document order is stable.
          // biome-ignore lint/suspicious/noArrayIndexKey: see above
          key={i}
          data-testid={
            r.drag ? "drag-region-overlay__rect--drag" : "drag-region-overlay__rect--no-drag"
          }
          title={r.label}
          className={`absolute border ${r.drag ? "border-red-500 bg-red-500/25" : "border-green-500 bg-green-500/25"}`}
          style={{ left: r.left, top: r.top, width: r.width, height: r.height }}
        />
      ))}
      {snapshot.covered.map((c, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: same as the rects
          key={i}
          data-testid="drag-region-overlay__covered"
          title={c.label}
          className="absolute outline-2 outline-yellow-400 outline-dashed"
          style={{ left: c.left, top: c.top, width: c.width, height: c.height }}
        />
      ))}
      <div
        data-testid="drag-region-overlay__legend"
        className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded bg-black/80 px-2 py-1 font-mono text-[11px] text-white"
      >
        drag region: {dragCount} drag, {snapshot.rects.length - dragCount} no-drag,{" "}
        {snapshot.covered.length} covered control{snapshot.covered.length === 1 ? "" : "s"}
        {snapshot.covered.length > 0 && ` (${snapshot.covered.map((c) => c.label).join(", ")})`}
        {snapshot.skippedParkedEntries > 0 &&
          `; ${snapshot.skippedParkedEntries} hidden workspace${snapshot.skippedParkedEntries === 1 ? "" : "s"} not read`}
      </div>
    </div>
  );
}
