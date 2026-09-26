/**
 * Admission and hardening rules for browser-pane `<webview>` guests.
 *
 * The dashboard window runs with `webviewTag: true` so browser tabs render
 * inside the DOM, where Band's menus, dialogs and tooltips can stack over
 * them with plain CSS. That tag is only safe with a gate: the renderer picks
 * a guest's `src`, `partition`, `preload` and `webpreferences` attributes,
 * and a renderer bug (or an XSS in the dashboard) must not be able to hand a
 * guest Node, the dashboard's preload bridge, or a session it does not own.
 *
 * `will-attach-webview` (wired in `main/webview-security.ts`) calls
 * `admitWebviewAttach` and, when it admits, `hardenGuestWebPreferences`.
 * The policy fails closed: an unknown partition or a `src` outside
 * http(s)/about:blank is refused, and every security-relevant preference is
 * overwritten rather than trusted from the markup. Same rules as orca's
 * `main-window-webview-security.ts`.
 *
 * Pure module (no Electron import) so `node:test` can exercise it.
 */

/**
 * Session partition for every browser-pane guest.
 *
 * Isolating the tabs from `session.defaultSession` (which the dashboard
 * window uses) matters for zoom: Chromium's zoom is stored per-origin
 * per-StoragePartition and propagates live to every webContents in the
 * partition, so with a shared session, zooming a tab pointed at the
 * dashboard's own origin (localhost:<port>) zoomed the dashboard window
 * itself and persisted that on disk. A dedicated partition keeps tab zoom
 * (and cookies/storage) away from the dashboard entirely.
 *
 * The renderer mirrors this string in `apps/web/src/lib/browser-webview.ts`.
 * Anything registered on `session.defaultSession` that tabs rely on must also
 * be registered on this partition's session: currently the `band-action://`
 * protocol handler (see `apps/desktop/src/main/index.ts`).
 */
export const BROWSER_PARTITION = "persist:band-browser";

/**
 * Per-profile partitions: `persist:band-browser-profile-<id>`, with the id
 * limited to a safe alphabet because the name becomes a directory under the
 * app's `Partitions/`. Same scheme as the browser profiles work (PR #667),
 * so a tab in a profile only has to set its partition.
 */
const PROFILE_PARTITION = /^persist:band-browser-profile-[A-Za-z0-9_-]{1,64}$/;

/**
 * Partitions a guest may attach with: the default browser partition or a
 * browser profile's. Anything else is refused, so a renderer cannot put a
 * guest in the dashboard's own session (or any other).
 */
function isAllowedBrowserPartition(partition: string): boolean {
  return partition === BROWSER_PARTITION || PROFILE_PARTITION.test(partition);
}

/** Initial `src` values a guest may attach with. */
function isAdmissibleInitialSrc(src: string): boolean {
  if (src === "about:blank") return true;
  try {
    const { protocol } = new URL(src);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export function admitWebviewAttach(args: { src: string; partition: string }): boolean {
  return isAllowedBrowserPartition(args.partition) && isAdmissibleInitialSrc(args.src);
}

/**
 * Overwrite every security-relevant preference of an admitted guest.
 * Mutates `webPreferences` in place, which is how `will-attach-webview`
 * expects the change. `preload` is the guest preload (`preload/guest.cts`),
 * which only pins `window.close` and exposes nothing.
 */
export function hardenGuestWebPreferences(
  webPreferences: Record<string, unknown>,
  params: Record<string, unknown>,
  preload: string,
): void {
  const partition = webPreferences.partition;
  // Electron copies the `preload` attribute into `params.preload`; older
  // builds also carry `preloadURL`. Drop both so the dashboard's preload
  // bridge (or anything else the markup names) can never reach a guest.
  delete params.preload;
  delete webPreferences.preloadURL;
  delete webPreferences.additionalArguments;
  webPreferences.preload = preload;
  webPreferences.nodeIntegration = false;
  webPreferences.nodeIntegrationInSubFrames = false;
  webPreferences.nodeIntegrationInWorker = false;
  webPreferences.contextIsolation = true;
  webPreferences.sandbox = true;
  webPreferences.webSecurity = true;
  webPreferences.allowRunningInsecureContent = false;
  webPreferences.enableBlinkFeatures = "";
  webPreferences.disableBlinkFeatures = "";
  webPreferences.webviewTag = false;
  // Keep the admitted partition: it is what isolates tab storage and zoom.
  webPreferences.partition = partition;
}

/**
 * Main-frame navigations a guest may start or be redirected to after it has
 * attached. `will-attach-webview` only sees the first `src`, so the guest's
 * `will-navigate` / `will-redirect` listeners keep enforcing an allowlist.
 *
 *   - http(s) and about: are ordinary browsing.
 *   - `blob:http(s)` is needed by Cloudflare Turnstile style challenges; an
 *     opaque blob (`blob:null`) is not.
 *   - `band-action:` is how the in-view error pages report button clicks
 *     (`error-html.ts`); the guest manager intercepts it before it commits.
 *   - `file:` is refused so a remote page cannot probe the filesystem, and
 *     other schemes (chrome:, custom app schemes) have no business in a tab.
 */
export function isAllowedGuestNavigation(url: string): boolean {
  if (url.startsWith("band-action:")) return true;
  if (url.startsWith("blob:http://") || url.startsWith("blob:https://")) return true;
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:" || protocol === "about:";
  } catch {
    return false;
  }
}
