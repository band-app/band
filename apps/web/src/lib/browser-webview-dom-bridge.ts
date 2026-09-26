// ---------------------------------------------------------------------------
// Two DOM behaviours a `<webview>` breaks, repaired once for the whole app.
//
// 1. Outside-click dismissal. A guest page runs in its own process, so a
//    click inside it never dispatches `pointerdown` on this document. Radix
//    popovers, dropdowns and context menus close on an outside
//    `pointerdown`, so without help they would stay open while the user
//    clicks around in the page. A click in the page does move focus to the
//    `<webview>` element, so on that `focusin` (or the window `blur` some
//    focus moves produce instead) we dispatch the `pointerdown`
//    the click would have produced, on the element itself. Every layer's
//    outside-click logic then runs unchanged. (Orca solves the same problem
//    per popover with window `blur` / `focusin` listeners.)
//
// 2. Drag and drop across a page. A guest swallows `dragover` / `drop`, so
//    an HTML5 drag (a file-tree row, a chat attachment) stalls the moment it
//    crosses a browser pane. While any drag is in progress every webview gets
//    `pointer-events: none`, which hands those events back to Band's DOM.
//    Dockview does the same for its own tab and sash drags.
// ---------------------------------------------------------------------------

let started = false;

function webviews(): NodeListOf<HTMLElement> {
  return document.querySelectorAll<HTMLElement>("webview");
}

/** Idempotent; called once from the renderer entry for the life of the page. */
export function startBrowserWebviewDomBridge(): void {
  if (started || typeof document === "undefined") return;
  started = true;

  const dismissOutside = (target: EventTarget | null) => {
    if (!(target instanceof HTMLElement) || target.tagName !== "WEBVIEW") return;
    target.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        composed: true,
        pointerType: "mouse",
        isPrimary: true,
        button: 0,
        buttons: 1,
      }),
    );
  };
  document.addEventListener("focusin", (event) => dismissOutside(event.target), true);
  // Some focus moves into a guest reach this document only as a window
  // `blur`, with the `<webview>` already the active element.
  window.addEventListener("blur", () => dismissOutside(document.activeElement));

  // Inline value each webview had before the drag, restored afterwards.
  const previous = new Map<HTMLElement, string>();
  const endPassthrough = () => {
    window.removeEventListener("pointermove", endPassthrough, true);
    for (const [webview, value] of previous) webview.style.pointerEvents = value;
    previous.clear();
  };
  window.addEventListener(
    "dragstart",
    () => {
      for (const webview of webviews()) {
        if (!previous.has(webview)) previous.set(webview, webview.style.pointerEvents);
        webview.style.pointerEvents = "none";
      }
      // No pointer events fire during an HTML5 drag, so the first one after
      // it is a backstop for a drag whose `dragend` never reached the window
      // (its source element was removed mid-drag).
      window.addEventListener("pointermove", endPassthrough, true);
    },
    true,
  );
  window.addEventListener("dragend", endPassthrough, true);
  window.addEventListener("drop", endPassthrough, true);
}
