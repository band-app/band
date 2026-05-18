/**
 * Pure helpers for surfacing non-cert navigation failures
 * (DNS, refused, timeout, etc.) as a Chrome-style "This site can't
 * be reached" error page in Band's browser pane.
 *
 * Companion to `cert-error.ts`. The cert-error pipeline handles the
 * `certificate-error` event — those failures have an extra
 * exception-store / Proceed flow. Everything else lands here via
 * Chromium's `did-fail-load` event.
 *
 * No Electron imports — keeps the helpers testable under `node:test`
 * with synthetic inputs.
 */

/**
 * Renderer payload for a `did-fail-load` failure.
 *
 * `snake_case` to match the convention used by every other browser-
 * pane IPC event in `shared/types.ts`.
 */
export interface BrowserLoadErrorPayload {
  browser_id: string;
  workspace_id: string;
  /** The URL Chromium was trying to load when the failure occurred. */
  url: string;
  /** Chromium's negative integer error code (e.g. -105 for
   *  `ERR_NAME_NOT_RESOLVED`). Plumbed verbatim so the renderer can
   *  show it in the "details" expander. */
  error_code: number;
  /** Chromium's stringified version of the error code, e.g.
   *  `"ERR_NAME_NOT_RESOLVED"`. */
  error_name: string;
  /** Short human-readable headline ("This site can't be reached")
   *  derived from the error code. Renderer paints this at the top. */
  headline: string;
  /** Longer human-readable explanation derived from the error code.
   *  Renderer paints this beneath the headline. */
  description: string;
}

/**
 * Chromium emits `did-fail-load` for a handful of expected/benign
 * cases that should NOT surface a full-page error to the user:
 *
 *   - `ERR_ABORTED` (-3): the navigation was canceled (e.g. the
 *     user clicked another link before the first request returned,
 *     or `window.stop()` ran). Showing an error here would replace
 *     the new page the user is navigating to with a stale failure
 *     state.
 *   - Cert errors (-200 to -299): the dedicated `certificate-error`
 *     listener handles those with the Chrome-style interstitial in
 *     `cert-error.ts`. We must NOT race with it.
 *
 * `isMainFrameFailure` likewise drops subframe failures — an iframe
 * failing to load should not blank the host page.
 */
export function isMainFrameFailure(args: { errorCode: number; isMainFrame: boolean }): boolean {
  if (!args.isMainFrame) return false;
  if (args.errorCode === -3) return false; // ERR_ABORTED
  // Cert errors get the interstitial pipeline; skip here. Range
  // covers `ERR_CERT_COMMON_NAME_INVALID` (-200) through every
  // `ERR_CERT_*` value Chromium currently defines.
  if (args.errorCode <= -200 && args.errorCode >= -299) return false;
  return true;
}

/**
 * Map a Chromium net error code to a Chrome-style headline +
 * description pair. The headlines mirror the ones Chrome ships
 * (Chromium's `net/base/net_error_list.h` + `chrome/browser/ssl/`
 * resources). Unknown codes fall back to a generic "This site
 * can't be reached" with the code surfaced so the user has
 * something to grep / Google.
 *
 * The `name` field is what Chromium would print to DevTools
 * (`ERR_NAME_NOT_RESOLVED`, `ERR_CONNECTION_REFUSED`, …). We use
 * it both as a debugging breadcrumb and as the renderer's "details"
 * expander value.
 */
export function describeLoadError(errorCode: number): {
  name: string;
  headline: string;
  description: string;
} {
  switch (errorCode) {
    case -105:
      return {
        name: "ERR_NAME_NOT_RESOLVED",
        headline: "This site can't be reached",
        description: "The server DNS address could not be found.",
      };
    case -106:
      return {
        name: "ERR_INTERNET_DISCONNECTED",
        headline: "No internet connection",
        description: "Your computer is offline. Check your network connection and try again.",
      };
    case -102:
      return {
        name: "ERR_CONNECTION_REFUSED",
        headline: "This site can't be reached",
        description: "The server refused the connection.",
      };
    case -101:
      return {
        name: "ERR_CONNECTION_RESET",
        headline: "This site can't be reached",
        description: "The connection was reset.",
      };
    case -118:
      return {
        name: "ERR_CONNECTION_TIMED_OUT",
        headline: "This site can't be reached",
        description: "The connection has timed out. The server may be too slow or unreachable.",
      };
    case -109:
      return {
        name: "ERR_ADDRESS_UNREACHABLE",
        headline: "This site can't be reached",
        description: "The server's address can't be reached from your network.",
      };
    case -130:
      return {
        name: "ERR_PROXY_CONNECTION_FAILED",
        headline: "Unable to connect to the proxy server",
        description: "Check your proxy settings and try again.",
      };
    case -137:
      return {
        name: "ERR_NAME_RESOLUTION_FAILED",
        headline: "This site can't be reached",
        description: "DNS lookup failed.",
      };
    case -20:
      return {
        name: "ERR_BLOCKED_BY_CLIENT",
        headline: "Blocked",
        description: "The request was blocked by a browser extension or filter.",
      };
    case -21:
      return {
        name: "ERR_NETWORK_CHANGED",
        headline: "Your connection was interrupted",
        description: "A network change was detected. Try reloading the page.",
      };
    case -7:
      return {
        name: "ERR_TIMED_OUT",
        headline: "This site can't be reached",
        description: "The operation timed out.",
      };
    case -6:
      return {
        name: "ERR_FILE_NOT_FOUND",
        headline: "File not found",
        description: "The file you requested could not be found.",
      };
    case -300:
      return {
        name: "ERR_DISALLOWED_URL_SCHEME",
        headline: "This site can't be reached",
        description: "The URL scheme is not supported.",
      };
    case -323:
      return {
        name: "ERR_INVALID_RESPONSE",
        headline: "This site can't be reached",
        description: "The server sent an invalid response.",
      };
    default:
      return {
        name: `ERR_${errorCode}`,
        headline: "This site can't be reached",
        description: "An unexpected error occurred while loading the page.",
      };
  }
}

/**
 * Build a renderer-facing payload from the raw arguments Chromium
 * hands the `did-fail-load` event. Caller provides the LRU `key`
 * so the payload can be filtered to the right tab — both
 * `browser_id` and `workspace_id` are set to the same value to
 * match the dual-key convention in `view-manager.ts::wireEvents`.
 *
 * Chromium also passes an `errorDescription` string but it's
 * notoriously empty for most codes (Chromium emits it from
 * `net::ErrorToString`, which is verbose only for a subset). We
 * prefer our own table so the surface text is consistent.
 */
export function buildLoadErrorPayload(args: {
  key: string;
  url: string;
  errorCode: number;
}): BrowserLoadErrorPayload {
  const { name, headline, description } = describeLoadError(args.errorCode);
  return {
    browser_id: args.key,
    workspace_id: args.key,
    url: args.url,
    error_code: args.errorCode,
    error_name: name,
    headline,
    description,
  };
}
