import { useEffect } from "react";
import { useSettingsQuery } from "@/dashboard";
import { invoke as desktopInvoke, listen as desktopListen } from "../lib/desktop-ipc";
import { isDesktop } from "../lib/is-desktop";
import { trpc } from "../lib/trpc-client";

// ---------------------------------------------------------------------------
// CDP screencast experiment — Browser Host bridge (desktop-only).
//
// This component runs once inside the desktop app's React tree. It connects
// the server-side `browserHost` tRPC procedures to the desktop's
// `BrowserGuestManager` over IPC, so the web client can ask the desktop to
// materialise a tab even when no UI panel for it is mounted.
//
// Wire-up:
//   1. Subscribe to `browserHost.ensureView` events (server → desktop).
//   2. For each event, call `browser_ensure` IPC (the tab's `<webview>` guest
//      if a pane has mounted it, else an offscreen page), then
//      `browser_get_cdp_target` to read the chromium target id, then
//      `browserHost.targetReady` mutation (desktop → server).
//   3. Listen to `browser-view-destroyed` events from BrowserGuestManager
//      (a page's WebContents went away or was replaced) and forward them to
//      the `browserHost.viewDestroyed` mutation so the server clears its
//      bandTabId → cdpTargetId cache.
//
// On the web build this is a no-op.
// ---------------------------------------------------------------------------

interface BrowserViewDestroyedPayload {
  browser_id: string;
}

export function BrowserHostBridge() {
  const { settings } = useSettingsQuery();
  const cdpEnabled = (settings as { webBrowserCdpEnabled?: boolean }).webBrowserCdpEnabled ?? false;

  useEffect(() => {
    if (!isDesktop) return;
    // The CDP screencast feature is opt-in via Settings → Browser. When
    // disabled (the default), the desktop didn't open
    // `--remote-debugging-port=9223` and the upstream WS would refuse to
    // connect; subscribing here would just spin in vain.
    if (!cdpEnabled) return;

    // ---- ensureView subscription ----
    const ensureSub = trpc.browserHost.ensureView.subscribe(undefined, {
      onData(event: {
        bandTabId: string;
        workspaceId: string;
        url: string;
        profileId?: string | null;
      }) {
        void (async () => {
          try {
            await desktopInvoke("browser_ensure", {
              browserId: event.bandTabId,
              url: event.url,
              profileId: event.profileId ?? null,
            });
            const cdpTargetId = (await desktopInvoke("browser_get_cdp_target", {
              browserId: event.bandTabId,
            })) as string;
            await trpc.browserHost.targetReady.mutate({
              bandTabId: event.bandTabId,
              cdpTargetId,
            });
          } catch (err) {
            // The server's ensure promise will time out if we don't report
            // back; that's the right surface — no point in propagating here.
            console.error("[BrowserHostBridge] ensureView failed:", err);
          }
        })();
      },
      onError(err: unknown) {
        console.warn("[BrowserHostBridge] ensureView subscription error:", err);
      },
    });

    // ---- view-destroyed listener (Electron event → tRPC mutation) ----
    let unlisten: (() => void) | undefined;
    void desktopListen<BrowserViewDestroyedPayload>("browser-view-destroyed", (e) => {
      const bandTabId = e.payload.browser_id;
      if (!bandTabId) return;
      trpc.browserHost.viewDestroyed
        .mutate({ bandTabId })
        .catch((err) => console.warn("[BrowserHostBridge] viewDestroyed mutate failed:", err));
    }).then((u) => {
      unlisten = u;
    });

    return () => {
      ensureSub.unsubscribe();
      unlisten?.();
    };
  }, [cdpEnabled]);

  return null;
}
