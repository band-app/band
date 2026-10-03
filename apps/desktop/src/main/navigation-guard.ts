/**
 * Keeps the main window on the bundled UI. The window loads `app://<host>/`
 * and never needs to leave it: a link to a web page opens in the user's
 * browser, and anything else (another scheme, another `app://` host, a `file:`
 * URL) is dropped. Programmatic loads such as a hub switch do not fire
 * `will-navigate`, so they are not affected.
 *
 * Pure functions so tests need no Electron.
 */

export type NavigationDecision = "allow" | "external" | "deny";

function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    // A custom scheme's origin is "null" in WHATWG URL; only `app:` is ours.
    if (parsed.origin === "null") {
      return parsed.protocol === "app:" ? `${parsed.protocol}//${parsed.host}` : null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

/** What to do when the page at `currentUrl` navigates itself to `targetUrl`. */
export function decideNavigation(currentUrl: string, targetUrl: string): NavigationDecision {
  const current = originOf(currentUrl);
  const target = originOf(targetUrl);
  if (current && target && current === target) return "allow";
  return decideOpen(targetUrl);
}

/** What to do with a `window.open` / `target="_blank"` request: never a new Band window. */
export function decideOpen(targetUrl: string): "external" | "deny" {
  try {
    const { protocol } = new URL(targetUrl);
    return protocol === "https:" || protocol === "http:" ? "external" : "deny";
  } catch {
    return "deny";
  }
}

/** Whether a frame URL belongs to the UI this app serves, and may be told the hub's token. */
export function isTrustedUiUrl(
  frameUrl: string | undefined,
  trustedOrigins: readonly string[],
): boolean {
  if (!frameUrl) return false;
  try {
    const url = new URL(frameUrl);
    // A custom scheme's `origin` is "null" in WHATWG URL, so compare scheme and host.
    return trustedOrigins.includes(`${url.protocol}//${url.host}`);
  } catch {
    return false;
  }
}
