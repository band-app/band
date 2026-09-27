import type { DockviewApi } from "dockview";

/**
 * Make a dockview tab strip scrollable by touch: a finger drag along the strip
 * scrolls it, and only a tap switches tabs.
 *
 * dockview activates a tab on `pointerdown`, so the tab under the finger
 * switches before the browser can tell a tap from a pan. For touch input this
 * hides that `pointerdown` from dockview and activates the tab on `click`
 * instead, which the browser fires only for a tap that did not scroll. Mouse
 * and pen input keep dockview's own `pointerdown` handling (drag to reorder /
 * split starts there).
 *
 * dockview's tab listeners skip an event whose `defaultPrevented` is true. A
 * real `preventDefault()` would also cancel Radix's long-press context menu on
 * the tab (it skips prevented events too), so instead `defaultPrevented` reads
 * true only while the event travels through dockview's elements: set in the
 * capture phase at `root`, removed when the event bubbles back to `root`,
 * before React's root listener sees it.
 *
 * Only tabs of `api`'s own groups are handled; tabs of dockviews nested inside
 * panel content are left alone. Returns a disposer.
 */
export function attachTouchTabActivation(root: HTMLElement, api: DockviewApi): () => void {
  // The tab whose touch `pointerdown` was hidden; a `click` on it activates it.
  let pendingTab: HTMLElement | null = null;

  const ownTab = (target: EventTarget | null): HTMLElement | null => {
    if (!(target instanceof Element)) return null;
    const tab = target.closest<HTMLElement>(".dv-tab");
    if (!tab || !root.contains(tab)) return null;
    // A nested dockview's `.dv-dockview` has another `.dv-dockview` above it.
    const dockview = tab.closest(".dv-dockview");
    if (!dockview || dockview.parentElement?.closest(".dv-dockview")) return null;
    return tab;
  };

  const onPointerDownCapture = (e: PointerEvent) => {
    pendingTab = null;
    if (e.pointerType !== "touch") return;
    const tab = ownTab(e.target);
    if (!tab) return;
    pendingTab = tab;
    Object.defineProperty(e, "defaultPrevented", { configurable: true, get: () => true });
  };

  const onPointerDownBubble = (e: PointerEvent) => {
    // Drop the own-property override so the prototype getter answers again.
    if (Object.hasOwn(e, "defaultPrevented")) {
      delete (e as { defaultPrevented?: boolean }).defaultPrevented;
    }
  };

  const onClick = (e: MouseEvent) => {
    const tab = pendingTab;
    pendingTab = null;
    if (!tab || ownTab(e.target) !== tab) return;
    // The close button handles its own tap.
    if (e.target instanceof Element && e.target.closest("button")) return;
    const panel = api.panels.find((p) => tab.contains(p.view.tab.element));
    panel?.api.setActive();
  };

  root.addEventListener("pointerdown", onPointerDownCapture, true);
  root.addEventListener("pointerdown", onPointerDownBubble);
  root.addEventListener("click", onClick);
  return () => {
    root.removeEventListener("pointerdown", onPointerDownCapture, true);
    root.removeEventListener("pointerdown", onPointerDownBubble);
    root.removeEventListener("click", onClick);
  };
}
