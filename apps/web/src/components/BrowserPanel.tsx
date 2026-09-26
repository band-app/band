import type { IDockviewPanelProps } from "dockview";
import { ArrowLeft, ArrowRight, RotateCw, Wrench, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useBrowserProfiles, useInvalidateBrowserProfiles, useSettingsQuery } from "@/dashboard";
import { useBrowserPaneControls } from "../hooks/useBrowserPaneControls";
import { useOverriddenHosts } from "../hooks/useOverriddenHosts";
import { registerBrowserGuest } from "../lib/browser-guest-retention";
import {
  type BrowserWebview,
  partitionForProfile,
  registerBrowserWebview,
} from "../lib/browser-webview";
import { invoke as desktopInvoke, listen as desktopListen } from "../lib/desktop-ipc";
import { isDesktop } from "../lib/is-desktop";
import { trpc } from "../lib/trpc-client";
import { AddressBarAutocomplete } from "./AddressBarAutocomplete";
import { BrowserFindBar } from "./BrowserFindBar";
import { BrowserProfileMenu } from "./BrowserProfileMenu";
import { HistoryPopover } from "./HistoryPopover";
import { NotSecureBadge } from "./NotSecureBadge";

const DEFAULT_URL = "";
const BLANK_URL = "about:blank";
// How long a pane waits for its tab record to exist (see the fetch effect
// in `BrowserPaneComponent`): 10 tries, 150 ms apart.
const TAB_RECORD_ATTEMPTS = 10;
const TAB_RECORD_RETRY_MS = 150;

// ---------------------------------------------------------------------------
// Favicon store — tracks per-browser favicon URLs for the tab strip.
// ---------------------------------------------------------------------------

const faviconMap = new Map<string, string>();
const faviconListeners = new Set<() => void>();

function setFaviconUrl(browserId: string, url: string) {
  if (faviconMap.get(browserId) !== url) {
    faviconMap.set(browserId, url);
    for (const listener of faviconListeners) listener();
  }
}

function subscribeFavicons(cb: () => void) {
  faviconListeners.add(cb);
  return () => {
    faviconListeners.delete(cb);
  };
}

/** Reactive hook that returns the current favicon URL for a browser tab. */
export function useFavicon(browserId: string): string | undefined {
  return useSyncExternalStore(subscribeFavicons, () => faviconMap.get(browserId));
}

// ---------------------------------------------------------------------------
// Browser pane params
// ---------------------------------------------------------------------------

export interface BrowserPaneParams {
  workspaceId: string;
  browserId: string;
  /** Whether the pane's workspace is the one on screen. */
  wsActive?: boolean;
  initialUrl?: string;
}

interface RegisterGuestResult {
  ok: boolean;
  adoptUrl: string | null;
}

/**
 * Create a `<webview>` for a tab in its browser profile's partition. The main
 * process admits it only in the default browser partition or a profile's,
 * with an http(s) or about:blank `src`, and overwrites
 * its security preferences (see `apps/desktop/src/main/webview-security.ts`),
 * so nothing here has to be trusted. `allowpopups` lets page popups reach
 * the main process, which always denies the OS window and opens a Band tab
 * instead.
 */
function createWebview(src: string, partition: string): BrowserWebview {
  const webview = document.createElement("webview") as BrowserWebview;
  webview.setAttribute("partition", partition);
  webview.setAttribute("allowpopups", "");
  // Opaque page canvas: a page without its own background paints white, as
  // in Chrome, instead of showing Band's theme through. Fullscreen requests
  // (a video's fullscreen button) fill the pane rather than resize the
  // window. Same guest preferences as orca's webviews.
  webview.setAttribute(
    "webpreferences",
    "transparent=false,disableHtmlFullscreenWindowResize=true",
  );
  webview.setAttribute("src", src);
  webview.className = "absolute inset-0 flex border-0 bg-background";
  return webview;
}

function isLoadableUrl(url: string): boolean {
  return url === BLANK_URL || /^https?:\/\//i.test(url);
}

/** Attach-time `src`: what `will-attach-webview` admits, else a blank page. */
function initialSrc(url: string): string {
  return isLoadableUrl(url) ? url : BLANK_URL;
}

// ---------------------------------------------------------------------------
// BrowserPaneComponent — one browser tab (desktop only).
//
// The page is an Electron `<webview>` inside this pane's DOM, so Band's
// menus, dialogs, tooltips and the find widget stack over it with plain CSS.
//
// Pitfalls this component is built around (same as orca's webview panes):
//
//   - Removing a `<webview>` from the DOM, or moving it to another parent,
//     destroys its guest. The leaf therefore uses dockview's
//     `renderer: "always"` so switching tabs toggles `display` instead of
//     detaching the panel, and the element is created imperatively and never
//     re-parented by React. A guest that is replaced anyway (a dockview group
//     merge re-parents panels) re-registers with the main process and
//     reloads the tab's last URL.
//   - Chromium stops painting a guest inside a `display: none`,
//     `visibility: hidden` or `content-visibility: hidden` subtree. That is
//     fine for the user, but the CDP screencast of a hidden tab needs frames.
//     With the CDP experiment on, a hidden pane marks itself
//     `data-band-browser-paint-retained`, and `globals.css` keeps just its
//     page painting at opacity 0 while its ancestors stay hidden.
//   - A click inside the page never reaches this document, so Radix layers
//     can't see an outside click; `lib/browser-webview-dom-bridge.ts`
//     synthesises one when focus moves into a webview.
//   - Keys typed inside the page never reach this document either. The main
//     process forwards the pane shortcuts and `WorkspaceCenterDockview`
//     re-dispatches them on the webview.
// ---------------------------------------------------------------------------

export function BrowserPaneComponent({
  params,
  api,
}: {
  params: BrowserPaneParams;
  api: IDockviewPanelProps<BrowserPaneParams>["api"];
}) {
  const { browserId, initialUrl, workspaceId: workspaceIdParam } = params;
  const wsActive = params.wsActive !== false;

  const [currentUrl, setCurrentUrl] = useState(() => initialUrl ?? DEFAULT_URL);
  const [inputUrl, setInputUrl] = useState(() => initialUrl ?? DEFAULT_URL);
  const [loading, setLoading] = useState(false);
  const browserIdRef = useRef(browserId);
  browserIdRef.current = browserId;
  const currentUrlRef = useRef(currentUrl);
  currentUrlRef.current = currentUrl;
  // `workspaceId` may be absent on the BrowserPaneParams when the panel
  // is restored from a saved layout that pre-dates the history feature.
  // Backfill it lazily from `trpc.browsers.get` so history recording and
  // autocomplete still know which workspace they belong to. Keep the
  // value in a ref so listeners read the latest workspace without
  // re-binding.
  const [workspaceId, setWorkspaceId] = useState(workspaceIdParam ?? "");
  const workspaceIdRef = useRef(workspaceId);
  workspaceIdRef.current = workspaceId;
  // Browser profile (cookie jar) of this tab, from the server's tab record.
  // `null` is the Default profile. A guest's partition is fixed when it is
  // created, so the page is only created once the profile is known, and is
  // recreated when it changes.
  const [profileId, setProfileId] = useState<string | null>(null);
  const [profileResolved, setProfileResolved] = useState(false);
  const { profiles, isLoaded: profilesLoaded } = useBrowserProfiles();
  const invalidateProfiles = useInvalidateBrowserProfiles();
  // A tab whose profile was deleted falls back to Default (the server also
  // rewrites the tab record).
  const effectiveProfileId =
    profileId !== null && profilesLoaded && !profiles.some((p) => p.id === profileId)
      ? null
      : profileId;
  const profileReady = profileResolved && (profileId === null || profilesLoaded);
  const profileIdRef = useRef(effectiveProfileId);
  profileIdRef.current = effectiveProfileId;
  const { isOverriddenHost } = useOverriddenHosts();
  const { settings } = useSettingsQuery();
  const cdpEnabled = (settings as { webBrowserCdpEnabled?: boolean }).webBrowserCdpEnabled ?? false;

  // On screen = selected tab in its group AND the workspace is shown.
  const [tabVisible, setTabVisible] = useState(api.isVisible);
  useEffect(() => {
    const d = api.onDidVisibilityChange((e) => setTabVisible(e.isVisible));
    return () => d.dispose();
  }, [api]);
  const visible = tabVisible && wsActive;

  // ------- guest lifecycle -------
  // `wantGuest` turns on the first time the pane is on screen (a restored
  // workspace with many tabs doesn't spin up every page at once) and off
  // when the hidden-workspace budget evicts the page. The page is rebuilt
  // at the last URL the next time the pane is shown.
  const [wantGuest, setWantGuest] = useState(false);
  useEffect(() => {
    if (isDesktop && visible) setWantGuest(true);
  }, [visible]);

  const hostRef = useRef<HTMLDivElement>(null);
  const [webview, setWebview] = useState<BrowserWebview | null>(null);
  const webviewRef = useRef<BrowserWebview | null>(null);
  webviewRef.current = webview;
  // Navigations requested before the guest can take `loadURL`.
  const readyRef = useRef(false);
  const pendingNavRef = useRef<string | null>(null);

  const navigateWebview = useCallback((url: string) => {
    const target = webviewRef.current;
    if (!target) return;
    // The main process only vets a guest's first `src` and the page's own
    // navigations; a URL from the server record or the address bar could be
    // anything (`file:`, `javascript:`), so the pane only loads web pages.
    if (!isLoadableUrl(url)) {
      console.warn("[BrowserPane] refusing to load", url);
      return;
    }
    if (!readyRef.current) {
      pendingNavRef.current = url;
      return;
    }
    // loadURL rejects on aborted or failed loads; failures are reported
    // through the guest's own events and error page, not here.
    target.loadURL(url).catch(() => {});
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!isDesktop || !wantGuest || !profileReady || !host) return;
    const startUrl = currentUrlRef.current || BLANK_URL;
    const wv = createWebview(initialSrc(startUrl), partitionForProfile(effectiveProfileId));
    readyRef.current = false;
    pendingNavRef.current = null;

    let registeredId: number | null = null;
    const register = () => {
      // Tie the guest to this tab so the main process can key its events and
      // resolve it for CDP and DevTools. Done on `dom-ready`, by which time
      // the main process has certainly run its `did-attach-webview` policy
      // for the guest (the element's own `did-attach` can race it). A guest
      // replaced by a re-parent comes back with a new id and re-registers.
      const webContentsId = wv.getWebContentsId();
      if (webContentsId === registeredId) return;
      registeredId = webContentsId;
      desktopInvoke<RegisterGuestResult>("browser_register_guest", {
        browserId: browserIdRef.current,
        webContentsId,
      })
        .then((result) => {
          if (!result.ok) {
            // Refused (should not happen for our own guest). Let the next
            // `dom-ready` try again rather than leave the tab unregistered.
            registeredId = null;
            console.error("[BrowserPane] browser_register_guest refused");
            return;
          }
          // An agent may have been driving this tab offscreen (CDP bridge)
          // before the pane mounted; continue from where it left off.
          if (result.adoptUrl && result.adoptUrl !== currentUrlRef.current) {
            navigateWebview(result.adoptUrl);
          }
        })
        .catch((err) => {
          registeredId = null;
          console.error("[BrowserPane] browser_register_guest failed", err);
        });
    };
    const onDomReady = () => {
      register();
      if (readyRef.current) return;
      readyRef.current = true;
      const pending = pendingNavRef.current;
      pendingNavRef.current = null;
      if (pending) wv.loadURL(pending).catch(() => {});
    };
    wv.addEventListener("dom-ready", onDomReady);
    host.appendChild(wv);
    const unregister = registerBrowserWebview(browserIdRef.current, wv);
    setWebview(wv);

    return () => {
      unregister();
      wv.removeEventListener("dom-ready", onDomReady);
      // Removing the element destroys the guest; the main process drops its
      // registration and tells the CDP bridge the target is gone.
      wv.remove();
      readyRef.current = false;
      setWebview(null);
    };
  }, [wantGuest, profileReady, effectiveProfileId, navigateWebview]);

  const handleProfileSelect = useCallback(
    (next: string | null) => {
      if (next === profileIdRef.current) return;
      trpc.browsers.setProfile
        .mutate({ browserId, profileId: next })
        .then(() => {
          // Recreates the page in the new profile at the current URL.
          setProfileId(next);
          // The project's default changed too; Settings shows it.
          void invalidateProfiles();
        })
        .catch((e) => console.error("Failed to switch browser profile:", e));
    },
    [browserId, invalidateProfiles],
  );

  const handleProfileImported = useCallback(
    (next: string) => {
      // Refetch first so the new id is in `profiles` before the tab uses it.
      void invalidateProfiles().then(() => handleProfileSelect(next));
    },
    [invalidateProfiles, handleProfileSelect],
  );

  // ------- hidden-workspace guest budget -------
  // While the page exists, offer it to the budget in
  // `browser-guest-retention.ts`. Evicting removes the webview; the effect
  // above rebuilds it at the last URL when the workspace is shown again.
  useEffect(() => {
    if (!webview || !workspaceId) return;
    const unregister = registerBrowserGuest(workspaceId, browserId, () => {
      // Leave the budget now rather than on the next commit, so an evicted
      // workspace stops counting as holding a live guest straight away.
      unregister();
      setWantGuest(false);
    });
    return unregister;
  }, [webview, workspaceId, browserId]);

  // ------- pane shortcuts typed inside the page -------
  // The page consumes its own keydowns. The main process swallows the pane
  // shortcuts (find, new tab, close, split, cycle) and forwards them; replay
  // each one as a `keydown` on the webview, where it bubbles through this
  // pane's `onKeyDown` and reaches the window listeners of
  // `WorkspaceCenterDockview` exactly like a key typed in Band's own UI.
  useEffect(() => {
    if (!isDesktop) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void desktopListen<{
      browser_id: string;
      key: string;
      code: string;
      shift: boolean;
      control: boolean;
      meta: boolean;
    }>("browser-guest-shortcut", (event) => {
      const p = event.payload;
      if (p.browser_id !== browserIdRef.current) return;
      webviewRef.current?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: p.key,
          code: p.code,
          shiftKey: p.shift,
          ctrlKey: p.control,
          metaKey: p.meta,
          bubbles: true,
          cancelable: true,
          composed: true,
        }),
      );
    }).then((u) => {
      if (disposed) u();
      else unlisten = u;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // ------- fetch the tab record from the server -------
  // The server browser record is the source of truth for the profile, and
  // for the URL when there is no initialUrl param (a browser created via CLI
  // with --url, or a workspace revisit adds the panel without one).
  //
  // A new tab's pane mounts while its `browsers.create` is still in flight,
  // so the record can be missing for a moment. Retry briefly before falling
  // back to Default, or a new tab would open outside its project's profile.
  useEffect(() => {
    if (!browserId) return;

    let cancelled = false;
    const load = async () => {
      let browser: Awaited<ReturnType<typeof trpc.browsers.get.query>>["browser"] = null;
      for (let attempt = 0; attempt < TAB_RECORD_ATTEMPTS && !cancelled; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, TAB_RECORD_RETRY_MS));
        try {
          browser = (await trpc.browsers.get.query({ browserId })).browser;
        } catch {
          // Server fetch failed — the user can still type a URL manually,
          // and the tab opens in the Default profile.
          break;
        }
        if (browser) break;
      }
      if (cancelled) return;
      setProfileId(browser?.profileId ?? null);
      setProfileResolved(true);
      if (initialUrl || !browser) return;
      const ws = browser.workspaceId;
      if (ws && !workspaceIdRef.current) {
        // Lazy workspace backfill — see comment on `workspaceId`
        // state above.
        setWorkspaceId(ws);
      }
      const url = browser.url;
      if (!url || url === BLANK_URL) return;
      setCurrentUrl(url);
      setInputUrl(url);
      // Before the guest exists the create effect picks the URL up from
      // `currentUrlRef`; afterwards navigate it.
      navigateWebview(url);
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [browserId, initialUrl, navigateWebview]);

  // ------- listen for URL / title changes from the main process -------
  // Persist URL to server (debounced) so it survives workspace switches.
  // Refs (`browserIdRef`, `currentUrlRef`, `addressInputFocusedRef`,
  // `urlPersistTimer`) are read via `.current` inside the listener —
  // adding `.current` to the deps would force the listener to re-bind
  // every URL/focus change. The `api` dep is the only thing that
  // should re-bind this effect.
  const urlPersistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (!isDesktop) return;
    let unlistenUrl: (() => void) | undefined;
    let unlistenTitle: (() => void) | undefined;

    (async () => {
      unlistenUrl = await desktopListen<{
        url: string;
        browser_id: string;
        loading: boolean;
      }>("browser-url-changed", (event) => {
        if (event.payload.browser_id !== browserIdRef.current) return;
        const url = event.payload.url;
        setLoading(event.payload.loading);
        if (url === BLANK_URL) return;
        setCurrentUrl(url);
        // Don't clobber the user's in-progress address-bar edit. If they
        // started typing mid-navigation, their text stays put until they
        // submit (Enter), abandon (Escape), or blur the input.
        if (!addressInputFocusedRef.current) {
          setInputUrl(url);
        }

        // Persist to server (debounced to avoid hammering on redirect chains)
        if (urlPersistTimer.current) clearTimeout(urlPersistTimer.current);
        urlPersistTimer.current = setTimeout(() => {
          trpc.browsers.navigate.mutate({ browserId: browserIdRef.current, url }).catch(() => {});
        }, 500);

        // Try to extract favicon from the URL's origin
        let faviconForHistory: string | undefined;
        try {
          const origin = new URL(url).origin;
          faviconForHistory = `${origin}/favicon.ico`;
          setFaviconUrl(browserIdRef.current, faviconForHistory);
        } catch {
          // ignore invalid URLs
        }

        // Record committed navigations into the per-workspace history.
        // Gated on `loading=false` so we only capture the final URL
        // after a redirect chain settles. The server filters
        // about:blank / chrome-extension / devtools / file URLs.
        if (!event.payload.loading && workspaceIdRef.current) {
          trpc.history.record
            .mutate({
              workspaceId: workspaceIdRef.current,
              url,
              faviconUrl: faviconForHistory,
            })
            .catch(() => {});
        }
      });
      unlistenTitle = await desktopListen<{ browser_id: string; title: string }>(
        "browser-title-changed",
        (event) => {
          if (event.payload.browser_id !== browserIdRef.current) return;
          if (event.payload.title) {
            api.setTitle(event.payload.title);
            // Backfill the title onto the existing history row for the
            // current URL. `page-title-updated` typically lands
            // 100-2000ms after `did-stop-loading`, so the row already
            // exists from the URL listener above.
            const url = currentUrlRef.current;
            if (url && url !== BLANK_URL && workspaceIdRef.current) {
              trpc.history.updateMeta
                .mutate({
                  workspaceId: workspaceIdRef.current,
                  url,
                  title: event.payload.title,
                })
                .catch(() => {});
            }
          }
        },
      );
    })();

    return () => {
      unlistenUrl?.();
      unlistenTitle?.();
      // Flush a pending URL persist before tearing down. Just clearing
      // the timer would lose the latest URL — e.g. when the user
      // navigates and then closes the pane before the debounce window
      // elapses. Fire the mutation with whatever URL
      // we have on hand; it's `void`-returning so it can safely race
      // the unmount.
      if (urlPersistTimer.current) {
        clearTimeout(urlPersistTimer.current);
        urlPersistTimer.current = null;
        const finalUrl = currentUrlRef.current;
        if (finalUrl && finalUrl !== BLANK_URL) {
          trpc.browsers.navigate
            .mutate({ browserId: browserIdRef.current, url: finalUrl })
            .catch(() => {});
        }
      }
    };
  }, [api]);

  // ------- navigation handlers -------

  const handleNavigate = useCallback(
    (rawUrl: string) => {
      let normalized = rawUrl.trim();

      // Empty input — load a blank page and clear the address bar.
      // The `browser-url-changed` listener filters out `about:blank`,
      // so the input stays visibly empty after the navigation lands.
      if (!normalized) {
        setCurrentUrl("");
        setInputUrl("");
        setLoading(false);
        navigateWebview(BLANK_URL);
        return;
      }

      if (!normalized.startsWith("http://") && !normalized.startsWith("https://")) {
        if (normalized.includes(".") && !normalized.includes(" ")) {
          normalized = `https://${normalized}`;
        } else {
          normalized = `https://www.google.com/search?q=${encodeURIComponent(normalized)}`;
        }
      }

      setCurrentUrl(normalized);
      setInputUrl(normalized);
      setLoading(true);
      navigateWebview(normalized);
    },
    [navigateWebview],
  );

  // The guest methods throw until it is attached and ready; the buttons are
  // harmless no-ops before that.
  const withReadyWebview = useCallback((fn: (wv: BrowserWebview) => void) => {
    const target = webviewRef.current;
    if (!target || !readyRef.current) return;
    try {
      fn(target);
    } catch (e) {
      console.error("[BrowserPane] webview call failed:", e);
    }
  }, []);

  const handleBack = useCallback(
    () => withReadyWebview((wv) => wv.canGoBack() && wv.goBack()),
    [withReadyWebview],
  );
  const handleForward = useCallback(
    () => withReadyWebview((wv) => wv.canGoForward() && wv.goForward()),
    [withReadyWebview],
  );
  const handleReload = useCallback(() => {
    setLoading(true);
    withReadyWebview((wv) => wv.reload());
  }, [withReadyWebview]);
  const handleStop = useCallback(() => {
    setLoading(false);
    withReadyWebview((wv) => wv.stop());
  }, [withReadyWebview]);

  // ------- pane chrome controls (find bar, DevTools, address-bar UX) -------
  const {
    find,
    addressInputFocusedRef,
    handleAddressFocus,
    handleAddressBlur,
    handleAddressKeyDown,
    handlePaneKeyDown,
    devToolsOpen,
    setDevToolsOpen,
    handleToggleDevTools,
    autocomplete,
    paneDataAttrs,
  } = useBrowserPaneControls({
    browserId,
    webview,
    workspaceId,
    currentUrlRef,
    setInputUrl,
    inputUrl,
    onNavigate: handleNavigate,
  });

  // ------- docked DevTools -------
  // DevTools render in a second `<webview>` under the page. Once that guest
  // attaches, the main process points the page's DevTools at it.
  const devToolsHostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = devToolsHostRef.current;
    if (!devToolsOpen || !webview || !host) return;
    // Same partition as the page, so DevTools' own fetches (source maps)
    // use the tab's profile.
    const dt = createWebview(BLANK_URL, partitionForProfile(profileIdRef.current));
    let opened = false;
    // Wait for the host's own blank page to commit: DevTools opened before
    // that are replaced by the host's initial `about:blank` navigation.
    const onReady = () => {
      dt.removeEventListener("dom-ready", onReady);
      desktopInvoke<boolean>("browser_open_dev_tools", {
        browserId: browserIdRef.current,
        devToolsWebContentsId: dt.getWebContentsId(),
      })
        .then((ok) => {
          opened = ok;
          if (!ok) setDevToolsOpen(false);
        })
        .catch(() => setDevToolsOpen(false));
    };
    const onClosed = () => setDevToolsOpen(false);
    dt.addEventListener("dom-ready", onReady);
    webview.addEventListener("devtools-closed", onClosed);
    host.appendChild(dt);
    return () => {
      dt.removeEventListener("dom-ready", onReady);
      webview.removeEventListener("devtools-closed", onClosed);
      if (opened) {
        desktopInvoke("browser_close_dev_tools", { browserId: browserIdRef.current }).catch(
          () => {},
        );
      }
      dt.remove();
    };
  }, [devToolsOpen, webview, setDevToolsOpen]);

  // A rebuilt page starts without DevTools.
  useEffect(() => {
    if (!webview) setDevToolsOpen(false);
  }, [webview, setDevToolsOpen]);

  if (!browserId) return null;

  if (!isDesktop) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        Browser panel is only available in the desktop app
      </div>
    );
  }

  // Keep a hidden page painting for the CDP screencast; see the header.
  const paintRetained = cdpEnabled && !visible && webview !== null;

  return (
    <div
      className="flex h-full w-full flex-col"
      onKeyDown={handlePaneKeyDown}
      inert={!visible}
      {...paneDataAttrs}
      {...(paintRetained ? { "data-band-browser-paint-retained": "" } : {})}
    >
      <div className="relative flex h-10 shrink-0 items-center gap-1 border-b border-border bg-background px-2">
        <button
          type="button"
          onClick={handleBack}
          className="flex items-center justify-center rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title="Back"
        >
          <ArrowLeft className="size-4" />
        </button>
        <button
          type="button"
          onClick={handleForward}
          className="flex items-center justify-center rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title="Forward"
        >
          <ArrowRight className="size-4" />
        </button>
        {loading ? (
          <button
            type="button"
            onClick={handleStop}
            className="flex items-center justify-center rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="Stop"
          >
            <X className="size-4" />
          </button>
        ) : (
          <button
            type="button"
            onClick={handleReload}
            className="flex items-center justify-center rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="Reload"
          >
            <RotateCw className="size-4" />
          </button>
        )}
        {isOverriddenHost(currentUrl) ? <NotSecureBadge /> : null}
        <input
          type="text"
          value={inputUrl}
          onChange={(e) => setInputUrl(e.target.value)}
          onKeyDown={handleAddressKeyDown}
          onFocus={handleAddressFocus}
          onBlur={handleAddressBlur}
          className="min-w-0 flex-1 rounded border border-transparent bg-muted/50 px-3 py-1.5 text-sm text-foreground outline-none transition-colors focus:border-border"
          placeholder="Enter URL or search..."
          // Stable hook for `WorkspaceCenterDockview` to focus the address
          // bar via `[data-band-address-input]` — more durable than
          // `input[type='text']`, which would also match the find-bar's
          // search input.
          data-band-address-input=""
        />
        <BrowserProfileMenu
          profiles={profiles}
          profileId={effectiveProfileId}
          onSelect={handleProfileSelect}
          onImported={handleProfileImported}
        />
        {workspaceId ? (
          <HistoryPopover workspaceId={workspaceId} onNavigate={handleNavigate} />
        ) : null}
        <button
          type="button"
          onClick={handleToggleDevTools}
          className="flex items-center justify-center rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title="Toggle DevTools"
        >
          <Wrench className="size-4" />
        </button>
        {loading && (
          <div className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-blue-500/10">
            <div
              className="h-full w-2/5 rounded-full bg-blue-500"
              style={{
                animation: "browser-bar-slide 1.4s ease-in-out infinite",
              }}
            />
          </div>
        )}
        {/* History autocomplete — absolutely positioned under the
            address-bar row (which is `relative`), on top of the page. */}
        <AddressBarAutocomplete state={autocomplete} onSelect={handleNavigate} />
      </div>
      {/* Page and docked DevTools, with the find widget floating over the
       *  page. Error pages (cert / "site can't be reached") are painted
       *  inside the page itself via a data: URI; see
       *  apps/desktop/src/browser/error-html.ts. `band-browser-guest-host`
       *  undoes the app zoom so the page renders at its own zoom only; the
       *  find widget sits outside it and keeps the app zoom. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div className="band-browser-guest-host flex min-h-0 flex-1 flex-col">
          <div ref={hostRef} className="relative min-h-10 flex-1" />
          {devToolsOpen ? (
            <div
              ref={devToolsHostRef}
              className="relative min-h-40 shrink-0 basis-2/5 border-t border-border"
            />
          ) : null}
        </div>
        <BrowserFindBar find={find} />
      </div>
    </div>
  );
}
