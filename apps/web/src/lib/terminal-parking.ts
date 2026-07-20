// ---------------------------------------------------------------------------
// Shared off-screen "parking" container for cached xterm instances.
//
// Band keeps one live xterm per terminal in a module-level cache
// (`terminal-cache.ts`). Each terminal is `open()`ed into a persistent wrapper
// <div> that is *moved* between the visible panel container and this hidden
// parking container — never disposed on a workspace/tab switch. Parking (rather
// than hiding the wrapper in place under `content-visibility: hidden`, the old
// MultiWorkspacePanelHost model) is what fixes the garbled-render-on-switch bug
// (band-app/band#615): a parked terminal lives in a normal-visibility subtree
// off to the side, so a workspace switch alone doesn't drop its WebGL backing
// store — re-attach reuses the same surface with a cheap fit + refresh, no
// rebuild. (Genuine off-screen GPU loss — sleep/unlock — is caught by the
// desktop `system-resumed` wake, and a real context drop by `onContextLoss`;
// see the repair policy in `terminal-cache.ts`.)
//
// The container is:
//   • position:fixed at (-9999px, -9999px) — rendered (so layout/paint keep the
//     surface warm) but never visible on screen. Given a real, non-zero size so
//     a parked terminal that keeps producing output isn't reflowed to 0 rows;
//     the cache deliberately does NOT re-fit while parked (see `detach`), so the
//     terminal simply retains its last-attached cols/rows.
//   • `inert` + `aria-hidden` — a parked terminal's `.xterm-helper-textarea` is
//     focusable in principle, and without `inert` a stray focus()/keystroke
//     could land in a background terminal. `inert` makes the whole subtree
//     non-focusable and non-interactive, which is the "no keystroke leak into a
//     parked terminal" guarantee (#617).
// ---------------------------------------------------------------------------

/** Off-screen dimensions large enough that a parked terminal keeps a sane
 *  cols/rows if some code path ever does re-measure it. We don't fit while
 *  parked, so this is just a safety floor, not the live size. */
const PARKING_WIDTH_PX = 800;
const PARKING_HEIGHT_PX = 600;

// Stash the node on `globalThis` so a Vite HMR reload of this module reuses the
// same container (and therefore keeps the already-parked wrappers) rather than
// orphaning it and leaking a detached DOM tree.
const PARKING_KEY = "__bandTerminalParking__";

interface ParkingGlobal {
  [PARKING_KEY]?: HTMLElement;
}

export function getParkingContainer(): HTMLElement {
  const store = globalThis as unknown as ParkingGlobal;
  const existing = store[PARKING_KEY];
  // Re-use only if it's still attached — a full page navigation can detach it.
  if (existing?.isConnected) return existing;

  const container = document.createElement("div");
  container.dataset.testid = "terminal-parking";
  // Rendered but off-screen. `visibility` stays `visible` (unlike the old
  // MultiWorkspacePanelHost hidden entries) so the browser keeps painting the
  // parked surface — that's the whole point of the parking model.
  Object.assign(container.style, {
    position: "fixed",
    left: "-9999px",
    top: "-9999px",
    width: `${PARKING_WIDTH_PX}px`,
    height: `${PARKING_HEIGHT_PX}px`,
    overflow: "hidden",
    // Keep it out of the pointer/hit-testing path entirely.
    pointerEvents: "none",
  } satisfies Partial<CSSStyleDeclaration>);

  // Focus/accessibility isolation. Set both the property (the standard API,
  // present in modern TS DOM lib) and the attribute as belt-and-suspenders for
  // any renderer that reflects one but not the other.
  container.inert = true;
  container.setAttribute("inert", "");
  container.setAttribute("aria-hidden", "true");

  document.body.appendChild(container);
  store[PARKING_KEY] = container;
  return container;
}
