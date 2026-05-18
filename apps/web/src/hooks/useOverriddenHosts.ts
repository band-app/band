import { useCallback, useEffect, useState } from "react";
import { invoke as desktopInvoke, listen as desktopListen } from "../lib/desktop-ipc";
import { isDesktop } from "../lib/is-desktop";

/**
 * Track which hostnames the user has accepted a TLS exception for
 * in this session (issue #444). The Chrome-style cert interstitial
 * itself is rendered INSIDE the WebContentsView via a `data:` URI
 * so cast viewers can see / proceed past it — see
 * `apps/desktop/src/browser/error-html.ts`. This hook is only for
 * the surrounding dashboard chrome: it tells `BrowserPanel.tsx`
 * which address bars should show a "Not Secure" badge.
 *
 * Two sources of truth:
 *
 *   1. The `browser-host-overridden` IPC event fires when the user
 *      clicks Proceed in the in-view interstitial. We add the host
 *      to the local set.
 *   2. On mount we ask the desktop for the current snapshot via
 *      `browser_get_overridden_hosts`, in case the renderer was
 *      restored after the user already proceeded (layout reload,
 *      window re-open, etc.).
 *
 * Session-scoped only. The desktop wipes the underlying
 * `CertExceptionStore` on quit, so the badge can't legitimately
 * outlive the override.
 */
export function useOverriddenHosts() {
  const [hosts, setHosts] = useState<Set<string>>(() => new Set());

  // ---- Subscribe to the host-overridden event ----
  useEffect(() => {
    if (!isDesktop) return;
    let unlisten: (() => void) | undefined;
    (async () => {
      unlisten = await desktopListen<{ host: string }>("browser-host-overridden", (event) => {
        const h = event.payload.host?.toLowerCase();
        if (!h) return;
        setHosts((prev) => {
          if (prev.has(h)) return prev;
          const next = new Set(prev);
          next.add(h);
          return next;
        });
      });
    })();
    return () => {
      unlisten?.();
    };
  }, []);

  // ---- Catch-up on mount ----
  useEffect(() => {
    if (!isDesktop) return;
    let cancelled = false;
    desktopInvoke<string[]>("browser_get_overridden_hosts")
      .then((list) => {
        if (cancelled || !Array.isArray(list) || list.length === 0) return;
        setHosts((prev) => {
          const next = new Set(prev);
          let changed = false;
          for (const h of list) {
            const lower = h.toLowerCase();
            if (!next.has(lower)) {
              next.add(lower);
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  /** Is the user currently on an overridden host? */
  const isOverriddenHost = useCallback(
    (currentUrl: string) => {
      if (!currentUrl) return false;
      let host: string;
      try {
        host = new URL(currentUrl).hostname.toLowerCase();
      } catch {
        return false;
      }
      return hosts.has(host);
    },
    [hosts],
  );

  return { isOverriddenHost };
}
