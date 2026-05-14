/**
 * Global "freeze browser panes" store + Radix-aware popup watcher.
 *
 * Electron's `WebContentsView` (the native browser pane host) is an
 * OS-level compositor layer that paints above the entire renderer DOM,
 * regardless of z-index. That means every Radix `Dialog`, `Popover`,
 * `DropdownMenu`, `ContextMenu`, `HoverCard`, `cmdk` palette, etc.
 * would render *behind* whichever browser tab is visible — invisible
 * to the user.
 *
 * VS Code solves this for its embedded webview panels by capturing a
 * raster snapshot of the view, displaying it as a static `<img>` in
 * the DOM, and hiding the live `WebContentsView`. Popover content
 * then stacks above the snapshot like any other DOM element. The
 * captured raster is frozen, so video pauses while an overlay is
 * open and animations don't continue — that's the same UX VS Code
 * exhibits.
 *
 * Architecture here:
 *
 *   1. `BrowserPaneFreezeStore` is a tiny external store that
 *      tracks a single boolean — "is any overlay currently open?".
 *      `BrowserPanel` subscribes via `useBrowserPaneFrozen()` and
 *      reacts: capture + hide on `true`, restore on `false`.
 *
 *   2. `startPopupWatcher()` installs a `MutationObserver` on
 *      `document.body` that queries for any Radix portal with
 *      `[data-state="open"]`. Whenever the count of open portals
 *      transitions across zero, it flips the store. This means we
 *      don't have to touch each of the ~25 popup components in the
 *      app to wire them up individually — one DOM observer covers
 *      Radix Dialog, Popover, DropdownMenu, ContextMenu, HoverCard,
 *      and anything else built on Radix Popper (which is everything
 *      in `packages/ui` plus cmdk's `Command.Dialog`).
 *
 *      The observer also watches `attributeFilter: ['data-state']`
 *      because Radix toggles state in-place rather than tearing
 *      down the portal on every open/close (animation-friendly).
 *
 *      Components that don't use Radix (inline flex strips like
 *      `AddressBarAutocomplete` and the AI-elements suggestion
 *      menus) don't need to participate — they're inside the normal
 *      flex flow and the placeholder div automatically shrinks
 *      around them via the existing `ResizeObserver` in
 *      `BrowserPanel`. Only floating-portal overlays trigger the
 *      freeze.
 */

import { useEffect, useSyncExternalStore } from "react";

// ---------------------------------------------------------------------------
// Store
//
// `frozen` is the public boolean — true while *anything* should keep the
// browser panes frozen. Two independent inputs feed it:
//
//   - `domOverlayCount`   number of Radix portals (Dialog, Popover,
//                         DropdownMenu, ContextMenu, HoverCard, Select,
//                         cmdk Command) currently open. Maintained by
//                         the `MutationObserver` in `startPopupWatcher`.
//
//   - `manualHoldCount`   ref-counted "I want the freeze" registrations
//                         from components that aren't Radix-portalled
//                         and so don't show up in `data-state="open"`
//                         scans — the address-bar autocomplete is the
//                         current consumer. Use `acquireFreezeHold` /
//                         `releaseFreezeHold` or the `useFreezeWhile`
//                         declarative wrapper.
//
// `frozen = (domOverlayCount + manualHoldCount) > 0`.
// ---------------------------------------------------------------------------

type Listener = () => void;

let domOverlayCount = 0;
let manualHoldCount = 0;
const listeners = new Set<Listener>();
let lastEmitted = false;

function isFrozen(): boolean {
  return domOverlayCount + manualHoldCount > 0;
}

function emitIfChanged(): void {
  const next = isFrozen();
  if (next === lastEmitted) return;
  lastEmitted = next;
  for (const l of listeners) l();
}

function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function getSnapshot(): boolean {
  return lastEmitted;
}

/**
 * Reactive boolean — `true` while any popup/dialog/dropdown is open
 * over the dashboard or any component is holding an explicit freeze.
 * `BrowserPanel` subscribes to decide whether to capture + hide its
 * native view.
 */
export function useBrowserPaneFrozen(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Imperative ref-counted hold. Use this when you have a UI surface
 * that needs the freeze but isn't visible to the DOM watcher (i.e.
 * not built on Radix). Call `release()` on close / unmount.
 *
 * For React components, prefer the `useFreezeWhile(open)` hook below
 * which handles the strict-mode / cleanup plumbing automatically.
 */
export function acquireFreezeHold(): () => void {
  manualHoldCount += 1;
  emitIfChanged();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    manualHoldCount = Math.max(0, manualHoldCount - 1);
    emitIfChanged();
  };
}

/**
 * Declaratively freeze the browser panes while `open` is true. Common
 * usage:
 *
 *   const [open, setOpen] = useState(false);
 *   useFreezeWhile(open);
 *
 * Strict-mode-safe: the effect's cleanup releases the hold on each
 * re-run / unmount, and React's double-invoke in dev cancels out
 * cleanly (acquire → release → acquire). The store ref-counts so
 * multiple components can hold concurrently without stomping.
 */
export function useFreezeWhile(open: boolean): void {
  useEffect(() => {
    if (!open) return;
    return acquireFreezeHold();
  }, [open]);
}

// ---------------------------------------------------------------------------
// Popup watcher
// ---------------------------------------------------------------------------

/**
 * Selectors covering every Radix portal that should be treated as an
 * "overlay" for freeze purposes. Each entry matches the inner content
 * node (the one Radix sets `data-state` on), not the wrapper portal
 * div — that way our MutationObserver can also key on attribute
 * changes when state flips from `open` to `closed`.
 *
 * Radix's data-slot attribute is the most stable selector: it's set
 * by every primitive in `packages/ui`'s wrappers (see
 * `popover.tsx` etc.) AND directly by Radix's own primitives in some
 * versions. We match on both forms to be safe.
 */
const OPEN_OVERLAY_SELECTORS = [
  // Wrappers in packages/ui that set data-slot.
  '[data-slot="dialog-content"][data-state="open"]',
  '[data-slot="popover-content"][data-state="open"]',
  '[data-slot="dropdown-menu-content"][data-state="open"]',
  '[data-slot="context-menu-content"][data-state="open"]',
  '[data-slot="hover-card-content"][data-state="open"]',
  '[data-slot="select-content"][data-state="open"]',
  // Radix native attributes — covers anything that doesn't go through
  // the packages/ui wrappers (third-party libs, future primitives).
  // We don't match on these alone because they'd also pick up some
  // *closed* nodes Radix leaves in the DOM during exit animations.
  '[role="dialog"][data-state="open"]',
  '[role="menu"][data-state="open"]',
  '[role="listbox"][data-state="open"]',
] as const;

function countOpenOverlays(): number {
  let total = 0;
  for (const sel of OPEN_OVERLAY_SELECTORS) {
    total += document.querySelectorAll(sel).length;
  }
  return total;
}

let watcherStarted = false;
let watcherCleanup: (() => void) | null = null;

/**
 * Idempotent — calling more than once is a no-op. Designed to be
 * invoked from the renderer entry (app bootstrap) and never undone
 * for the life of the page.
 */
export function startPopupWatcher(): () => void {
  if (watcherStarted) return watcherCleanup ?? (() => {});
  watcherStarted = true;

  if (typeof window === "undefined" || typeof document === "undefined") {
    // SSR / test env without a DOM — silently no-op.
    return () => {};
  }

  // Initial check — handles the case where overlays were already
  // rendered before the watcher attached (vanishingly unlikely in
  // practice, but cheap to cover).
  domOverlayCount = countOpenOverlays();
  emitIfChanged();

  // We batch via rAF because Radix can flip several `data-state`
  // attributes in a single tick (e.g. a menu closing while a dialog
  // opens), and we only need the final state.
  let scheduled = false;
  const sync = (): void => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      domOverlayCount = countOpenOverlays();
      emitIfChanged();
    });
  };

  const observer = new MutationObserver(sync);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    // Only attribute we actually care about — without this filter the
    // observer fires on every class/style mutation in the entire
    // subtree, which is a lot.
    attributeFilter: ["data-state"],
  });

  watcherCleanup = () => {
    observer.disconnect();
    watcherStarted = false;
    watcherCleanup = null;
    domOverlayCount = 0;
    emitIfChanged();
  };
  return watcherCleanup;
}
