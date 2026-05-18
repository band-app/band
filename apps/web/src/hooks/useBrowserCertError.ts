import { useCallback, useEffect, useRef, useState } from "react";
import type { CertErrorState } from "../components/CertErrorInterstitial";
import { invoke as desktopInvoke, listen as desktopListen } from "../lib/desktop-ipc";
import { isDesktop } from "../lib/is-desktop";

/**
 * Per-tab cert-error state for the Chrome-style interstitial flow
 * (issue #444). Subscribes to the `browser-cert-error` IPC event so
 * the host panel can render the interstitial when Chromium rejects
 * a TLS certificate.
 *
 * `key` is the IPC routing id (`workspaceId` for the legacy single-
 * panel mode, `browserId` for the multi-tab mode). `keyName` matches
 * the field name the desktop's `browserKey()` resolver expects so
 * the proceed / clear / get IPCs go to the right tab.
 *
 * The hook also tracks which hosts the user has *proceeded past* in
 * this session. That set drives the "Not Secure" badge in the
 * address bar: while the user is browsing a host whose cert they
 * overrode, we surface the unsafe state in the chrome.
 *
 * Session-scoped just like the desktop-side store — the set lives in
 * component state and is wiped when the panel unmounts or the user
 * reloads. That's by design: the desktop's exception map is *also*
 * cleared on quit, so the badge can't legitimately survive longer
 * than the desktop's overrides.
 */
export function useBrowserCertError(args: {
  /** Routing id — `workspaceId` for `BrowserPanelComponent`,
   *  `browserId` for `BrowserPaneComponent`. Empty string until the
   *  panel knows its id. */
  key: string;
  keyName: "workspaceId" | "browserId";
}) {
  const { key, keyName } = args;
  const [state, setState] = useState<CertErrorState | null>(null);
  const [overriddenHosts, setOverriddenHosts] = useState<Set<string>>(() => new Set());
  // Refs so the event listener can read the latest id without re-binding
  // on every render. Mirrors the pattern used in `BrowserPanel.tsx`.
  const keyRef = useRef(key);
  keyRef.current = key;

  // ---- Subscribe to the desktop-side cert-error event ----
  // Keep the listener attached for the lifetime of the panel; the
  // key-routing check below makes sure we only react to events
  // targeted at *this* tab. `keyRef` is intentionally read via
  // `.current` inside the listener so the listener doesn't have
  // to re-bind on every key change (matches the pattern in
  // `BrowserPanel.tsx`).
  useEffect(() => {
    if (!isDesktop) return;
    let unlisten: (() => void) | undefined;
    (async () => {
      unlisten = await desktopListen<{
        browser_id: string;
        workspace_id: string;
        url: string;
        host: string;
        error_code: string;
        error_description: string;
        fingerprint: string;
        subject_name?: string;
        issuer_name?: string;
        valid_start?: number;
        valid_expiry?: number;
      }>("browser-cert-error", (event) => {
        const matches =
          keyName === "workspaceId"
            ? event.payload.workspace_id === keyRef.current
            : event.payload.browser_id === keyRef.current;
        if (!matches) return;
        setState({
          url: event.payload.url,
          host: event.payload.host,
          errorCode: event.payload.error_code,
          errorDescription: event.payload.error_description,
          fingerprint: event.payload.fingerprint,
          subjectName: event.payload.subject_name,
          issuerName: event.payload.issuer_name,
          validStart: event.payload.valid_start,
          validExpiry: event.payload.valid_expiry,
        });
      });
    })();
    return () => {
      unlisten?.();
    };
  }, [keyName]);

  // ---- Catch-up on mount ----
  // If the cert-error event fired before this listener was attached
  // (e.g. layout restore lands during the initial navigation), poll
  // the desktop for the pending error so the interstitial still shows.
  useEffect(() => {
    if (!isDesktop || !key) return;
    let cancelled = false;
    desktopInvoke<{
      url: string;
      host: string;
      error_code: string;
      error_description: string;
      fingerprint: string;
      subject_name?: string;
      issuer_name?: string;
      valid_start?: number;
      valid_expiry?: number;
    } | null>("browser_get_cert_error_for_view", { [keyName]: key })
      .then((pending) => {
        if (cancelled || !pending) return;
        setState((prev) =>
          prev
            ? prev
            : {
                url: pending.url,
                host: pending.host,
                errorCode: pending.error_code,
                errorDescription: pending.error_description,
                fingerprint: pending.fingerprint,
                subjectName: pending.subject_name,
                issuerName: pending.issuer_name,
                validStart: pending.valid_start,
                validExpiry: pending.valid_expiry,
              },
        );
      })
      .catch(() => {
        // No pending error / desktop offline / etc.
      });
    return () => {
      cancelled = true;
    };
  }, [key, keyName]);

  // ---- Actions ----
  // `proceed` records a session exception for (host, fingerprint),
  // triggers a tab reload, marks the host as "overridden" so the
  // address bar surfaces the warning, and dismisses the interstitial.
  const proceed = useCallback(async () => {
    if (!state || !key) return;
    const hostToMark = state.host;
    try {
      await desktopInvoke("browser_proceed_with_cert_error", {
        [keyName]: key,
        host: state.host,
        fingerprint: state.fingerprint,
      });
    } catch (e) {
      console.error("browser_proceed_with_cert_error failed:", e);
      return;
    }
    setOverriddenHosts((prev) => {
      if (prev.has(hostToMark)) return prev;
      const next = new Set(prev);
      next.add(hostToMark);
      return next;
    });
    setState(null);
  }, [state, key, keyName]);

  // `clear` is the "Back to safety" path. The caller is expected to
  // also navigate the tab away from the failing URL (or close it);
  // this hook just resets the per-pane state and tells the desktop
  // to drop its pending error entry.
  const clear = useCallback(async () => {
    setState(null);
    if (!key) return;
    try {
      await desktopInvoke("browser_clear_cert_error", { [keyName]: key });
    } catch {
      // ignored — clearing is best-effort, the tab navigation will
      // also clear the pending error from `did-start-navigation`.
    }
  }, [key, keyName]);

  /** Is the user currently on a host whose cert was overridden? */
  const isOverriddenHost = useCallback(
    (currentUrl: string) => {
      if (!currentUrl) return false;
      let host: string;
      try {
        host = new URL(currentUrl).hostname.toLowerCase();
      } catch {
        return false;
      }
      return overriddenHosts.has(host);
    },
    [overriddenHosts],
  );

  return { state, proceed, clear, isOverriddenHost };
}
