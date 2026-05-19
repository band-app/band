import { useCallback, useSyncExternalStore } from "react";
import { invoke as desktopInvoke, listen as desktopListen } from "../lib/desktop-ipc";
import { isDesktop } from "../lib/is-desktop";

/**
 * Track which hostnames the user has accepted a TLS exception for
 * in this session (issue #444). The Chrome-style cert interstitial
 * itself is rendered INSIDE the WebContentsView via a `data:` URI
 * so cast viewers can see / proceed past it — see
 * `apps/desktop/src/browser/error-html.ts`. This module is only for
 * the surrounding dashboard chrome: it tells `BrowserPanel.tsx`
 * which address bars should show a "Not Secure" badge.
 *
 * Design — **module-scoped singleton store**:
 *
 * `useOverriddenHosts` is consumed by every browser pane
 * (`BrowserPanelComponent` AND `BrowserPaneComponent`), so a naive
 * `useEffect`/`useState` implementation would mount one IPC
 * subscription and one catch-up call per panel. With N tabs open,
 * boot fires N catch-up IPCs and registers N event listeners.
 *
 * Instead we keep the state in module scope: one `Set<string>` of
 * overridden hosts, one set of subscribers, **one** IPC catch-up
 * + listener bootstrapped lazily on the first hook use. Multiple
 * hook callers share that single subscription via React 18's
 * `useSyncExternalStore`. Same pattern this file's sibling
 * (`useFavicon` in `BrowserPanel.tsx`) uses for the favicon store,
 * picked here because:
 *
 *   - React Context would re-render every consumer whenever any
 *     host is overridden (the Set ref changes). The store + sync-
 *     external pattern triggers only the consumers whose
 *     `getSnapshot()` result actually changes, and we use
 *     `useCallback` so the `isOverriddenHost` reference is stable
 *     per `hosts` Set identity.
 *   - No provider boilerplate to wire into the dashboard tree.
 *   - Zero React lifecycle on first use → no startup IPC storm
 *     when the user has many tabs.
 *
 * Session-scoped only. The desktop wipes the underlying
 * `CertExceptionStore` on quit, so the badge can't legitimately
 * outlive the override.
 */

// ---- Module state ----

let hosts: Set<string> = new Set();
const listeners = new Set<() => void>();
let bootstrapped = false;

/** Notify every subscribed React component that `hosts` has changed.
 *  The `useSyncExternalStore` snapshot identity is what triggers
 *  the re-render, so we *replace* the Set rather than mutating it. */
function setHosts(updater: (prev: Set<string>) => Set<string>): void {
  const next = updater(hosts);
  if (next === hosts) return;
  hosts = next;
  for (const cb of listeners) cb();
}

function addHost(raw: string): void {
  const h = raw.toLowerCase();
  if (!h || hosts.has(h)) return;
  setHosts((prev) => {
    const next = new Set(prev);
    next.add(h);
    return next;
  });
}

/**
 * Subscribe ONCE to the desktop-side override stream and do the
 * one-shot catch-up. Called lazily from the first `useOverriddenHosts`
 * mount; protected by a flag so subsequent mounts are O(1) no-ops.
 *
 * We deliberately don't tear this subscription down — it's
 * process-lifetime state (matches the session lifetime of the
 * underlying `CertExceptionStore` on the desktop side). React 18
 * StrictMode double-effect is also safe here because the flag
 * makes the second call a no-op.
 */
function bootstrap(): void {
  if (bootstrapped) return;
  if (!isDesktop) return;
  bootstrapped = true;

  void desktopListen<{ host: string }>("browser-host-overridden", (event) => {
    if (event.payload.host) addHost(event.payload.host);
  }).catch((err) => {
    // Don't lock the flag — if the listen call fails (e.g. preload
    // not ready yet) allow a later subscriber to retry by resetting.
    console.error("browser-host-overridden listen failed:", err);
    bootstrapped = false;
  });

  desktopInvoke<string[]>("browser_get_overridden_hosts")
    .then((list) => {
      if (!Array.isArray(list)) return;
      for (const h of list) addHost(h);
    })
    .catch((err) => {
      // Don't silently swallow — the most likely cause is an
      // outdated preload allowlist (version skew on update). Log
      // so the missing badge has a breadcrumb to chase.
      console.error("browser_get_overridden_hosts failed:", err);
    });
}

function subscribe(cb: () => void): () => void {
  bootstrap();
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): Set<string> {
  return hosts;
}

// ---- React hook ----

/**
 * Reactive accessor for the session's overridden-hosts set. Returns
 * `isOverriddenHost(url)` — pass the current URL of a browser pane
 * to decide whether to paint the "Not Secure" badge.
 *
 * The hook subscribes through `useSyncExternalStore`, so it re-
 * renders only when `hosts` actually changes. The returned
 * `isOverriddenHost` callback is `useCallback`-stable per `hosts`
 * Set identity, which keeps downstream memoisation honest.
 */
export function useOverriddenHosts() {
  const currentHosts = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const isOverriddenHost = useCallback(
    (currentUrl: string): boolean => {
      if (!currentUrl) return false;
      let host: string;
      try {
        host = new URL(currentUrl).hostname.toLowerCase();
      } catch {
        return false;
      }
      return currentHosts.has(host);
    },
    [currentHosts],
  );
  return { isOverriddenHost };
}

// ---- Test helper ----
// Exported only so unit tests can reset module state between
// cases. Not part of the React surface; do not call from
// component code.
export function __resetOverriddenHostsForTests(): void {
  hosts = new Set();
  listeners.clear();
  bootstrapped = false;
}
