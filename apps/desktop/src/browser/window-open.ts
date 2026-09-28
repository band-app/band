/**
 * Decide what to do when a page inside a Band browser tab requests a
 * new window (via `window.open(...)`, `target="_blank"`, or middle /
 * Cmd+click on a link). Issue #488.
 *
 * Chromium fires every one of those through `webContents.setWindowOpenHandler`
 * — `BrowserViewManager.wireEvents` registers a handler that
 * unconditionally returns `{ action: "deny" }` (so no detached
 * OS-level window ever appears) and uses this helper to decide whether
 * to ALSO emit a `browser-open-window` IPC event that the renderer
 * turns into a new Band browser tab in the same workspace.
 *
 * Extracted as a pure module so the routing rules can be exercised in
 * `node:test` without an Electron runtime — same pattern as
 * `cert-error.ts` / `load-error.ts`.
 */

export type WindowOpenAction =
  | { kind: "open-in-band"; url: string }
  | { kind: "ignore"; reason: WindowOpenIgnoreReason };

export type WindowOpenIgnoreReason =
  | "empty-url"
  | "about-blank"
  | "javascript-scheme"
  | "unsupported-scheme";

/**
 * URL schemes we'll surface as new Band tabs. Anything outside this
 * allow-list is denied without creating a tab — `data:`, `file:`,
 * `chrome:`, custom app schemes etc. would either look broken in a
 * Band tab (no address-bar affordance) or actively unsafe to surface.
 */
const SUPPORTED_SCHEMES = ["http:", "https:"] as const;

export function decideWindowOpenAction(url: string): WindowOpenAction {
  const trimmed = url?.trim() ?? "";

  if (!trimmed) {
    return { kind: "ignore", reason: "empty-url" };
  }

  // `window.open("about:blank")` is the popup-then-document.write
  // pattern. We deny the OS window AND skip creating a Band tab
  // — the page can't script into a `WebContentsView` we never
  // handed back, so the resulting blank tab would just be litter
  // the user has to close manually.
  if (trimmed.toLowerCase() === "about:blank") {
    return { kind: "ignore", reason: "about-blank" };
  }

  // `javascript:` URLs are page-side-effect calls (bookmarklets etc.)
  // — there's no navigation target to surface. Denying the OS window
  // is already the correct user-visible outcome.
  if (/^javascript:/i.test(trimmed)) {
    return { kind: "ignore", reason: "javascript-scheme" };
  }

  // Anything else has to look like a URL we'd be willing to load in
  // a Band tab. Relative paths (e.g. `/foo`) are technically possible
  // here too — Chromium resolves them against the opener's origin
  // before calling the handler in modern versions, but we accept
  // the raw string and let the renderer / Chromium re-resolve on
  // navigation. The point of this gate is just to reject
  // schemes we know we don't want to surface.
  let parsed: URL;
  try {
    // `URL` requires a base for relative paths; supply a sentinel so
    // we can still inspect the scheme. The sentinel never leaves
    // this function.
    parsed = new URL(trimmed, "about:blank");
  } catch {
    // Not a parsable URL → not safe to surface.
    return { kind: "ignore", reason: "unsupported-scheme" };
  }

  if (!SUPPORTED_SCHEMES.includes(parsed.protocol as (typeof SUPPORTED_SCHEMES)[number])) {
    return { kind: "ignore", reason: "unsupported-scheme" };
  }

  return { kind: "open-in-band", url: trimmed };
}
