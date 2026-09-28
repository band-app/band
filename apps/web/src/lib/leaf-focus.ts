import type { DockviewApi, IDockviewPanel } from "dockview";
import { focusEditorQuietly } from "../dashboard/lib/quiet-focus";
import { terminalSplitApiForLeaf } from "./terminal-split-registry";

/**
 * Keyboard focus for the center dockview's leaves.
 *
 * When a leaf becomes the active one (Ctrl+Tab, ⌘⇧[ / ⌘⇧], the palette's
 * Next / Previous Tab, a tab click, closing the tab before it, a workspace
 * switch), focus has to move into it. Otherwise it stays on the tab strip or
 * falls to `<body>` when the old leaf's content is hidden, and the next
 * Ctrl+Tab is lost.
 *
 * The target per kind:
 *   - term: the xterm textarea of the active pane in the leaf's nested split
 *   - file: the CodeMirror editor, the markdown preview included (it's a
 *     CodeMirror view too); a read-only viewer (image, PDF) gets the leaf root
 *   - diff: the diff's scroller, so the arrow keys scroll it
 *   - chat: the composer textarea
 *   - browser: the address bar. The page may still be loading, and a blank tab
 *     has nothing else to type into.
 *
 * A leaf's content can mount late: the xterm attaches after React commits the
 * leaf's visibility, a file or chat renders after its query. Until the target
 * exists, focus sits on the leaf root (`[data-band-leaf-root]`, tabindex -1),
 * which keeps it inside the dockview so Ctrl+Tab keeps working.
 */

/** Marks the element a leaf wants focused (chat composer, diff scroller). */
export const LEAF_FOCUS_ATTR = "data-band-leaf-focus";
/** Marks a leaf's focusable root, the fallback while its content loads. */
export const LEAF_ROOT_ATTR = "data-band-leaf-root";

/** Give up on a leaf whose content hasn't mounted after this long. */
const FOCUS_DEADLINE_MS = 2_000;

// The xterm textarea that last had focus in each terminal leaf (keyed by the
// leaf root). The nested split's active pane doesn't follow a focus that came
// without a click, so it can't say which pane the user was typing in.
const lastTerminalInput = new WeakMap<Element, HTMLElement>();
if (typeof document !== "undefined") {
  document.addEventListener(
    "focusin",
    (e) => {
      const el = e.target;
      if (!(el instanceof HTMLElement) || !el.classList.contains("xterm-helper-textarea")) return;
      const leafRoot = el.closest(`[${LEAF_ROOT_ATTR}]`);
      if (leafRoot) lastTerminalInput.set(leafRoot, el);
    },
    true,
  );
}

/** The element that should hold focus while `panel` is the active leaf, or
 *  `null` when its content hasn't mounted (or has nothing focusable). */
export function leafFocusTarget(panel: IDockviewPanel): HTMLElement | null {
  const root = panel.view.content.element;
  switch (panel.api.component) {
    case "term": {
      // A parked xterm's wrapper is outside the leaf until it re-attaches.
      const leafRoot = root.querySelector(`[${LEAF_ROOT_ATTR}]`);
      const last = leafRoot ? lastTerminalInput.get(leafRoot) : undefined;
      if (last && root.contains(last)) return last;
      const pane = terminalSplitApiForLeaf(panel.id)?.activePanel?.view.content.element ?? root;
      return pane.querySelector<HTMLElement>(".xterm-helper-textarea");
    }
    case "browser":
      return root.querySelector<HTMLElement>("[data-band-address-input]");
    case "file":
      return root.querySelector<HTMLElement>('.cm-content[contenteditable="true"]');
    default:
      return root.querySelector<HTMLElement>(`[${LEAF_FOCUS_ATTR}]`);
  }
}

/** True when a modal surface (dialog, menu, popover list) holds focus. */
function inModal(el: Element): boolean {
  return (
    el.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]') != null
  );
}

/** Focus that was left behind in the dockview: on a tab header, a leaf root,
 *  or a leaf that is now hidden. Not a header button like the "+" menu. */
function isStrandedIn(container: HTMLElement, el: Element): boolean {
  if (!container.contains(el)) return false;
  return (
    el.closest(".dv-tab") != null ||
    el.hasAttribute(LEAF_ROOT_ATTR) ||
    el.getClientRects().length === 0
  );
}

export interface FocusLeafOptions {
  /** The dockview's container. Focus stranded in it (see `isStrandedIn`) is
   *  moved. */
  container: HTMLElement;
  /** Take focus from anywhere outside a dialog or menu, not only from the
   *  container or `<body>`. For a workspace switch, where focus is in the
   *  sidebar or the workspace picker. */
  force?: boolean;
  /** Checked every frame; stop once it's false (the workspace was hidden). */
  isCurrent: () => boolean;
}

/**
 * Move focus into the dockview's active leaf, retrying each frame until the
 * leaf's target exists or 2 s pass. It never takes focus from something the
 * user focused inside the leaf, and stops when another leaf becomes active.
 * Returns a cancel function.
 */
export function focusActiveLeaf(api: DockviewApi, opts: FocusLeafOptions): () => void {
  const panel = api.activePanel;
  if (!panel) return () => {};
  const deadline = performance.now() + FOCUS_DEADLINE_MS;
  const root = panel.view.content.element;
  // Force covers only the first move. After that, a click on the sidebar
  // while the leaf is still loading must not be undone.
  let force = opts.force === true;
  let raf = 0;

  const step = () => {
    raf = 0;
    if (performance.now() > deadline || api.activePanel !== panel || !opts.isCurrent()) return;
    const active = document.activeElement;
    const target = leafFocusTarget(panel);
    if (target && active === target) return;
    const onBody = !active || active === document.body;
    const onLeafRoot = active?.hasAttribute(LEAF_ROOT_ATTR) === true && root.contains(active);
    // Something inside the leaf already has focus: a click, a find bar, an
    // autofocused input. Leave it there.
    if (active && !onBody && !onLeafRoot && root.contains(active)) return;
    const ours =
      !active || onBody || isStrandedIn(opts.container, active) || (force && !inModal(active));
    if (ours) {
      force = false;
      // A CodeMirror editor gets a quiet focus, so the markdown preview stays
      // rendered where its cursor happens to be.
      if (target?.classList.contains("cm-content")) focusEditorQuietly(target);
      else if (target) target.focus({ preventScroll: true });
      else root.querySelector<HTMLElement>(`[${LEAF_ROOT_ATTR}]`)?.focus({ preventScroll: true });
      if (target && document.activeElement === target) return;
    }
    raf = requestAnimationFrame(step);
  };

  // A frame late: the leaf's content is re-attached and a tab click's own focus
  // on the tab header has landed by then.
  raf = requestAnimationFrame(step);
  return () => {
    if (raf) cancelAnimationFrame(raf);
  };
}
