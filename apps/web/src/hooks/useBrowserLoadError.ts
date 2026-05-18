import { useCallback, useEffect, useRef, useState } from "react";
import type { LoadErrorState } from "../components/LoadErrorPage";
import { invoke as desktopInvoke, listen as desktopListen } from "../lib/desktop-ipc";
import { isDesktop } from "../lib/is-desktop";

/**
 * Per-tab generic-load-error state for the Chrome-style
 * "This site can't be reached" page. Companion to
 * `useBrowserCertError` — same shape, different event source
 * (`did-fail-load` rather than `certificate-error`).
 *
 * `key` is the IPC routing id (`workspaceId` for the legacy single-
 * panel mode, `browserId` for the multi-tab mode). `keyName` matches
 * the field name the desktop's `browserKey()` resolver expects.
 */
export function useBrowserLoadError(args: { key: string; keyName: "workspaceId" | "browserId" }) {
  const { key, keyName } = args;
  const [state, setState] = useState<LoadErrorState | null>(null);
  const keyRef = useRef(key);
  keyRef.current = key;

  // ---- Subscribe to the desktop-side load-error event ----
  // Refs read inside the listener so we don't re-bind on every
  // key change — mirrors the pattern in `BrowserPanel.tsx`.
  useEffect(() => {
    if (!isDesktop) return;
    let unlisten: (() => void) | undefined;
    (async () => {
      unlisten = await desktopListen<{
        browser_id: string;
        workspace_id: string;
        url: string;
        error_code: number;
        error_name: string;
        headline: string;
        description: string;
      }>("browser-load-error", (event) => {
        const matches =
          keyName === "workspaceId"
            ? event.payload.workspace_id === keyRef.current
            : event.payload.browser_id === keyRef.current;
        if (!matches) return;
        setState({
          url: event.payload.url,
          errorCode: event.payload.error_code,
          errorName: event.payload.error_name,
          headline: event.payload.headline,
          description: event.payload.description,
        });
      });
    })();
    return () => {
      unlisten?.();
    };
  }, [keyName]);

  // ---- Catch-up on mount ----
  // If the event fired before the listener attached (e.g. layout
  // restore lands during the initial navigation), poll the desktop
  // for the pending error so the page still shows.
  useEffect(() => {
    if (!isDesktop || !key) return;
    let cancelled = false;
    desktopInvoke<{
      url: string;
      error_code: number;
      error_name: string;
      headline: string;
      description: string;
    } | null>("browser_get_load_error_for_view", { [keyName]: key })
      .then((pending) => {
        if (cancelled || !pending) return;
        setState((prev) =>
          prev
            ? prev
            : {
                url: pending.url,
                errorCode: pending.error_code,
                errorName: pending.error_name,
                headline: pending.headline,
                description: pending.description,
              },
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [key, keyName]);

  // `retry` re-loads the failing URL captured in the pending entry
  // and dismisses the page. The desktop side clears the entry as
  // part of the retry.
  const retry = useCallback(async () => {
    if (!state || !key) return;
    setState(null);
    try {
      await desktopInvoke("browser_retry_load_error", { [keyName]: key });
    } catch (e) {
      console.error("browser_retry_load_error failed:", e);
    }
  }, [state, key, keyName]);

  // `clear` is the dismiss path. Caller is expected to navigate the
  // tab away from the failing URL as part of the same action.
  const clear = useCallback(async () => {
    setState(null);
    if (!key) return;
    try {
      await desktopInvoke("browser_clear_load_error", { [keyName]: key });
    } catch {
      // best-effort
    }
  }, [key, keyName]);

  return { state, retry, clear };
}
