// The desktop window's drag region, computed the way Chromium 148 (Electron 42)
// does it: every box with `app-region: drag` or `no-drag` and `visibility:
// visible`, in document order, each `drag` border box added and each `no-drag`
// one cut out. Clipping, z-index, opacity, pointer-events and `inert` don't
// count. See the comment block after the drag rule in `dockview-theme.css`.
//
// Parked workspace entries (`data-band-parked`, content-visibility: hidden)
// are skipped: reading a style inside one forces the style recalc Chromium
// skipped there, so the walk would change the region it is trying to show.

export interface DragRegionRect {
  drag: boolean;
  left: number;
  top: number;
  width: number;
  height: number;
  /** data-testid, or the first class name, of the element. */
  label: string;
}

export interface CoveredControl {
  left: number;
  top: number;
  width: number;
  height: number;
  label: string;
}

export interface DragRegionSnapshot {
  rects: DragRegionRect[];
  /** Top-row controls that a drag rect covers: a click there drags the window. */
  covered: CoveredControl[];
  /** Parked workspace entries the walk did not read. */
  skippedParkedEntries: number;
}

/** Controls that must take clicks: tabs, tab close buttons, strip header
 *  buttons, and the nav cluster. */
const CONTROL_SELECTOR =
  '.dv-tab, .dv-tabs-and-actions-container button, [data-testid="app-shell__nav-overlay"] button';

const PARKED_SELECTOR = "[data-band-parked]";

function appRegionOf(style: CSSStyleDeclaration): string {
  return style.getPropertyValue("app-region") || style.getPropertyValue("-webkit-app-region");
}

function labelOf(el: Element): string {
  const named = el.matches("[data-testid]") ? el : el.querySelector("[data-testid]");
  return (
    named?.getAttribute("data-testid") ??
    el.getAttribute("aria-label") ??
    ((el.textContent ?? "").trim().slice(0, 40) || el.tagName.toLowerCase())
  );
}

/** The part of `el` its overflow-clipping ancestors show. Only that part can
 *  take a click: a tab scrolled out of the strip isn't covered by the drag
 *  rect it slid under. */
function visiblePart(el: Element): { left: number; top: number; right: number; bottom: number } {
  const r = el.getBoundingClientRect();
  let [left, top, right, bottom] = [r.left, r.top, r.right, r.bottom];
  for (let a = el.parentElement; a; a = a.parentElement) {
    if (getComputedStyle(a).overflowX === "visible") continue;
    const c = a.getBoundingClientRect();
    left = Math.max(left, c.left);
    right = Math.min(right, c.right);
    top = Math.max(top, c.top);
    bottom = Math.min(bottom, c.bottom);
  }
  return { left, top, right, bottom };
}

export function isInDragRegion(rects: readonly DragRegionRect[], x: number, y: number): boolean {
  let drag = false;
  for (const r of rects) {
    if (x >= r.left && x < r.left + r.width && y >= r.top && y < r.top + r.height) drag = r.drag;
  }
  return drag;
}

export function snapshotDragRegion(doc: Document = document): DragRegionSnapshot {
  const rects: DragRegionRect[] = [];
  // Document order, with each parked entry's whole subtree skipped.
  const walker = doc.createTreeWalker(doc.documentElement, NodeFilter.SHOW_ELEMENT, {
    acceptNode: (node) =>
      (node as Element).hasAttribute("data-band-parked")
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  for (let node = walker.currentNode; node; node = walker.nextNode() as Node) {
    const el = node as Element;
    const style = getComputedStyle(el);
    const region = appRegionOf(style);
    if (region !== "drag" && region !== "no-drag") continue;
    // Chromium only adds boxes: no inline boxes, no `display: contents`.
    if (
      style.visibility !== "visible" ||
      style.display === "inline" ||
      style.display === "contents"
    ) {
      continue;
    }
    const box = el.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) continue;
    rects.push({
      drag: region === "drag",
      left: box.left,
      top: box.top,
      width: box.width,
      height: box.height,
      label: el.getAttribute("data-testid") ?? (el.classList[0] || el.tagName.toLowerCase()),
    });
  }

  const covered: CoveredControl[] = [];
  for (const el of doc.querySelectorAll(CONTROL_SELECTOR)) {
    if (el.closest(PARKED_SELECTOR) || el.closest("[inert]")) continue;
    if (!el.checkVisibility({ visibilityProperty: true })) continue;
    const box = visiblePart(el);
    if (box.right - box.left <= 0 || box.bottom - box.top <= 0) continue;
    let hit = false;
    for (let x = box.left + 1; x < box.right - 1 && !hit; x += 3) {
      for (let y = box.top + 1; y < box.bottom - 1 && !hit; y += 3) {
        hit = isInDragRegion(rects, x, y);
      }
    }
    if (hit) {
      covered.push({
        left: box.left,
        top: box.top,
        width: box.right - box.left,
        height: box.bottom - box.top,
        label: labelOf(el),
      });
    }
  }

  return { rects, covered, skippedParkedEntries: doc.querySelectorAll(PARKED_SELECTOR).length };
}
