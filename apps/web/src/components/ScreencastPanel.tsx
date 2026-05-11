import {
  type DockviewApi,
  DockviewReact,
  type DockviewReadyEvent,
  type DockviewTheme,
  type IDockviewHeaderActionsProps,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
} from "dockview";
import { ArrowLeft, ArrowRight, Globe, Plus, RotateCw } from "lucide-react";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { trpc } from "../lib/trpc-client";

// ---------------------------------------------------------------------------
// CDP screencast pane (experiment) — web fallback for the Browser pane.
//
// Uses DockviewReact directly to mirror the desktop Browser pane's tab
// strip + per-panel address bar + content layout. Each Band browser tab
// (from `/api/cdp/tabs?workspaceId=…`, which is now backed by Band's DB
// via `browser-manager.ts`) becomes a dockview panel; the active panel
// streams via `Page.startScreencast` through the `/cdp?bandTabId=…`
// WebSocket proxy.
//
// On the server side, the proxy resolves `bandTabId` to the current
// chromium target id (asking the desktop to materialise a WebContentsView
// if one doesn't exist yet via the `browserHost.ensureView` tRPC bridge).
// All identifiers in this component are Band ids — we never see chromium's
// CDP target ids on the wire.
// ---------------------------------------------------------------------------

interface ScreencastPanelProps {
  workspaceId: string;
  visible: boolean;
}

interface CdpTab {
  id: string;
  url: string;
  title: string;
}

interface TabsResponse {
  tabs: CdpTab[];
  error?: string | null;
}

const TABS_POLL_MS = 5000;

// Same theme class as DockviewBrowserContainer so the inner tabs pick up
// the desktop browser-pane styling.
const screencastTabTheme: DockviewTheme = {
  name: "band",
  className: "dockview-theme-band dockview-browser-tabs",
};

export function ScreencastPanel({ workspaceId, visible }: ScreencastPanelProps) {
  const [tabs, setTabs] = useState<CdpTab[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const fetchTabs = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const res = await fetch(`/api/cdp/tabs?workspaceId=${encodeURIComponent(workspaceId)}`, {
          signal,
          cache: "no-store",
        });
        const body = (await res.json()) as TabsResponse;
        setTabs(body.tabs ?? []);
        setError(body.error ?? null);
      } catch (err) {
        if ((err as { name?: string }).name === "AbortError") return;
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoaded(true);
      }
    },
    [workspaceId],
  );

  // Poll while the outer pane is visible.
  useEffect(() => {
    if (!visible) return;
    const ctrl = new AbortController();
    fetchTabs(ctrl.signal);
    const id = setInterval(() => fetchTabs(ctrl.signal), TABS_POLL_MS);
    return () => {
      ctrl.abort();
      clearInterval(id);
    };
  }, [visible, fetchTabs]);

  if (loaded && error) {
    return (
      <div className="flex h-full w-full items-center justify-center p-6">
        <ErrorPanel error={error} />
      </div>
    );
  }

  if (loaded && tabs.length === 0) {
    return (
      <div className="flex h-full w-full items-center justify-center p-6">
        <EmptyPanel />
      </div>
    );
  }

  return <ScreencastDockview tabs={tabs} outerVisible={visible} workspaceId={workspaceId} />;
}

// ---------------------------------------------------------------------------
// Inner DockviewReact instance + panel sync.
// ---------------------------------------------------------------------------

interface ScreencastDockviewProps {
  tabs: CdpTab[];
  outerVisible: boolean;
  workspaceId: string;
}

interface StreamPanelParams {
  bandTabId: string;
  url: string;
  outerVisible: boolean;
}

// ---------------------------------------------------------------------------
// "+" header action — module-level so dockview gets a stable component
// reference. The actual onClick callback is rebound via newTabRef on every
// render of ScreencastDockview so the closure captures the current
// workspaceId.
// ---------------------------------------------------------------------------

const newTabRef: { current: (() => void) | null } = { current: null };

const ScreencastRightHeaderActions = React.memo(function ScreencastRightHeaderActions(
  _props: IDockviewHeaderActionsProps,
) {
  return (
    <div className="flex h-full items-center pr-1">
      <button
        type="button"
        className="inline-flex size-8 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        onClick={() => newTabRef.current?.()}
        title="New browser tab"
        aria-label="New browser tab"
      >
        <Plus className="size-4" />
      </button>
    </div>
  );
});

function ScreencastDockview({ tabs, outerVisible, workspaceId }: ScreencastDockviewProps) {
  const apiRef = useRef<DockviewApi | null>(null);

  // Bind the latest "new tab" handler into the module-level ref so the
  // dockview header action picks up the current workspaceId. Same
  // pattern as `addTabRef` in `DockviewBrowserContainer`.
  const handleNewTab = useCallback(() => {
    trpc.browsers.create
      .mutate({ workspaceId })
      .catch((err) => console.warn("[ScreencastPanel] browsers.create failed:", err));
  }, [workspaceId]);
  newTabRef.current = handleNewTab;

  // Diff dockview panels against the polled tab list and add/remove/update.
  // Active-tab sync (web↔desktop) is no longer needed: under the single-
  // adapter model both renderers observe the same chromium target, so the
  // tab strip on each side is a UI-local concern.
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;

    const wantIds = new Set(tabs.map((t) => t.id));
    const haveIds = new Set(api.panels.map((p) => p.id));

    for (const id of haveIds) {
      if (!wantIds.has(id)) {
        const panel = api.getPanel(id);
        if (panel) api.removePanel(panel);
      }
    }

    for (const tab of tabs) {
      const existing = api.getPanel(tab.id);
      if (existing) {
        // Don't overwrite the panel's title from polled DB state — once
        // the tab has been streamed at least once, `StreamPanel` calls
        // `api.setTitle(...)` with the live title CDP extracted from
        // `document.title`, which is fresher than `browser-manager`'s
        // `name` field. We just keep the URL params in sync.
        existing.api.updateParameters({
          bandTabId: tab.id,
          url: tab.url,
          outerVisible,
        } satisfies StreamPanelParams);
      } else {
        api.addPanel({
          id: tab.id,
          component: "stream",
          title: tab.title || tab.url || "(no title)",
          params: { bandTabId: tab.id, url: tab.url, outerVisible } satisfies StreamPanelParams,
        });
      }
    }

    if (!api.activePanel && api.panels.length > 0) {
      api.panels[0].api.setActive();
    }
  }, [tabs, outerVisible]);

  // Propagate outer visibility into mounted panels.
  useEffect(() => {
    const api = apiRef.current;
    if (!api) return;
    for (const panel of api.panels) {
      const params = panel.api.getParameters<StreamPanelParams>();
      if (params.outerVisible !== outerVisible) {
        panel.api.updateParameters({ ...params, outerVisible });
      }
    }
  }, [outerVisible]);

  const onReady = useCallback((event: DockviewReadyEvent) => {
    apiRef.current = event.api;
  }, []);

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background text-foreground">
      <DockviewReact
        theme={screencastTabTheme}
        className="h-full"
        components={panelComponents}
        defaultTabComponent={ScreencastTab}
        rightHeaderActionsComponent={ScreencastRightHeaderActions}
        onReady={onReady}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Favicon store — module-level Map<bandTabId, faviconUrl> with subscriber
// hook. Mirrors the desktop browser pane's `useFavicon`. StreamView writes
// here after parsing the page; ScreencastTab reads via useSyncExternalStore.
// ---------------------------------------------------------------------------

const faviconByBandTabId = new Map<string, string>();
const faviconListeners = new Set<() => void>();

function setFaviconForBandTab(bandTabId: string, url: string | null): void {
  const current = faviconByBandTabId.get(bandTabId);
  if (url) {
    if (current === url) return;
    faviconByBandTabId.set(bandTabId, url);
  } else {
    if (current === undefined) return;
    faviconByBandTabId.delete(bandTabId);
  }
  for (const listener of faviconListeners) listener();
}

function subscribeFavicons(cb: () => void): () => void {
  faviconListeners.add(cb);
  return () => {
    faviconListeners.delete(cb);
  };
}

function useFaviconForBandTab(bandTabId: string): string | undefined {
  return useSyncExternalStore(
    subscribeFavicons,
    () => faviconByBandTabId.get(bandTabId),
    () => undefined,
  );
}

// ---------------------------------------------------------------------------
// Custom tab header — favicon (with Globe fallback) + truncated title.
// ---------------------------------------------------------------------------

function ScreencastTab(props: IDockviewPanelHeaderProps<StreamPanelParams>) {
  const [title, setTitle] = useState(props.api.title ?? "");
  const [faviconErrored, setFaviconErrored] = useState(false);

  useEffect(() => {
    const d = props.api.onDidTitleChange(() => setTitle(props.api.title ?? ""));
    return () => d.dispose();
  }, [props.api]);

  const bandTabId = props.params.bandTabId;
  const favicon = useFaviconForBandTab(bandTabId);
  const prevFaviconRef = useRef(favicon);
  if (favicon !== prevFaviconRef.current) {
    prevFaviconRef.current = favicon;
    if (faviconErrored) setFaviconErrored(false);
  }

  return (
    <div className="dv-default-tab">
      <div className="flex min-w-0 items-center gap-1.5">
        {favicon && !faviconErrored ? (
          <img
            src={favicon}
            alt=""
            className="size-3.5 shrink-0"
            onError={() => setFaviconErrored(true)}
          />
        ) : (
          <Globe className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="truncate">{title || "(no title)"}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-tab panel content — address bar above the live stream.
// ---------------------------------------------------------------------------

type CdpSender = (method: string, params?: Record<string, unknown>) => void;

function StreamPanel({ params, api }: IDockviewPanelProps<StreamPanelParams>) {
  // Combine dockview's panel-level visibility (only the active tab in a
  // tabbed group is `isVisible`) with the outer-pane visibility passed via
  // params. The stream's WS only runs while both are true.
  const [panelVisible, setPanelVisible] = useState(api.isVisible);
  useEffect(() => {
    const d = api.onDidVisibilityChange((e) => setPanelVisible(e.isVisible));
    return () => d.dispose();
  }, [api]);

  const visible = panelVisible && params.outerVisible;

  // Lifted state shared between AddressBar (which sends nav commands)
  // and StreamView (which owns the WS and surfaces these events). The
  // `sendCdpRef` is written to by StreamView once its WS opens; the
  // AddressBar reads from it for back/forward/reload/navigate.
  const sendCdpRef = useRef<CdpSender | null>(null);
  const [currentUrl, setCurrentUrl] = useState(params.url);
  const [loading, setLoading] = useState(false);

  // When the polled tab list updates the params.url (e.g. another client
  // navigated this tab), reflect it here unless we've already received a
  // fresher Page.frameNavigated event (which is what currentUrl tracks).
  useEffect(() => {
    setCurrentUrl(params.url);
  }, [params.url]);

  const navigate = useCallback((rawUrl: string) => {
    const trimmed = rawUrl.trim();
    if (!trimmed) return;
    const url = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
    sendCdpRef.current?.("Page.navigate", { url });
  }, []);
  const reload = useCallback(() => {
    sendCdpRef.current?.("Page.reload");
  }, []);
  const stopLoading = useCallback(() => {
    sendCdpRef.current?.("Page.stopLoading");
  }, []);
  // CDP's Page.getNavigationHistory + Page.navigateToHistoryEntry is two
  // roundtrips; using the page's own JS history is one roundtrip and works
  // for the common cases. canGoBack / canGoForward are deferred (not
  // tracked) — clicks no-op if there's no history entry.
  const goBack = useCallback(() => {
    sendCdpRef.current?.("Runtime.evaluate", { expression: "history.back()" });
  }, []);
  const goForward = useCallback(() => {
    sendCdpRef.current?.("Runtime.evaluate", { expression: "history.forward()" });
  }, []);

  // Reflect page title onto the dockview tab via api.setTitle. Favicon
  // goes into the module-level store; ScreencastTab reads it via
  // useFaviconForBandTab.
  const handlePageMetaChange = useCallback(
    (meta: { title?: string; favicon?: string | null }) => {
      if (typeof meta.title === "string") {
        const next = meta.title.trim() || params.url || "(no title)";
        if ((api.title ?? "") !== next) {
          api.setTitle(next);
        }
      }
      if (meta.favicon !== undefined) {
        setFaviconForBandTab(params.bandTabId, meta.favicon);
      }
    },
    [api, params.url, params.bandTabId],
  );

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <AddressBar
        url={currentUrl}
        loading={loading}
        onNavigate={navigate}
        onBack={goBack}
        onForward={goForward}
        onReload={reload}
        onStop={stopLoading}
      />
      <div className="relative flex-1 overflow-hidden bg-muted/30">
        <StreamView
          bandTabId={params.bandTabId}
          visible={visible}
          sendCdpRef={sendCdpRef}
          onUrlChange={setCurrentUrl}
          onLoadingChange={setLoading}
          onPageMetaChange={handlePageMetaChange}
        />
      </div>
    </div>
  );
}

// biome-ignore lint/suspicious/noExplicitAny: dockview requires generic panel props
const panelComponents: Record<string, React.FunctionComponent<IDockviewPanelProps<any>>> = {
  stream: StreamPanel,
};

// ---------------------------------------------------------------------------
// Address bar — back / forward / reload / editable URL. Mirrors the desktop
// Browser pane's address bar visually + functionally; the only difference
// is that the controls translate to CDP messages on the wire instead of
// Electron IPC.
// ---------------------------------------------------------------------------

interface AddressBarProps {
  url: string;
  loading: boolean;
  onNavigate: (url: string) => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onStop: () => void;
}

function AddressBar({
  url,
  loading,
  onNavigate,
  onBack,
  onForward,
  onReload,
  onStop,
}: AddressBarProps) {
  // Local input state so the user can edit without round-tripping through
  // currentUrl. We sync from the prop whenever it changes (e.g. the
  // streamed page navigates itself) — but ONLY if the input isn't focused,
  // so we don't blow away what the user is typing.
  const [inputUrl, setInputUrl] = useState(url);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (document.activeElement !== inputRef.current) {
      setInputUrl(url);
    }
  }, [url]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        onNavigate(inputUrl);
      }
    },
    [inputUrl, onNavigate],
  );

  return (
    <div className="relative flex h-10 shrink-0 items-center gap-1 border-b border-border bg-background px-2">
      {/* Keyframes for the indeterminate loading bar. */}
      <style>{`@keyframes screencast-bar-slide {
  0% { transform: translateX(-100%); }
  50% { transform: translateX(200%); }
  100% { transform: translateX(-100%); }
}`}</style>
      <button
        type="button"
        onClick={onBack}
        title="Back"
        aria-label="Back"
        className="flex items-center justify-center rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
      </button>
      <button
        type="button"
        onClick={onForward}
        title="Forward"
        aria-label="Forward"
        className="flex items-center justify-center rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <ArrowRight className="size-4" />
      </button>
      {loading ? (
        <button
          type="button"
          onClick={onStop}
          title="Stop"
          aria-label="Stop"
          className="flex items-center justify-center rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Globe className="size-4" />
        </button>
      ) : (
        <button
          type="button"
          onClick={onReload}
          title="Reload"
          aria-label="Reload"
          className="flex items-center justify-center rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <RotateCw className="size-4" />
        </button>
      )}
      <input
        ref={inputRef}
        type="text"
        value={inputUrl}
        onChange={(e) => setInputUrl(e.target.value)}
        onKeyDown={onKeyDown}
        onFocus={(e) => e.target.select()}
        placeholder="Enter URL or search…"
        className="min-w-0 flex-1 rounded border border-transparent bg-muted/50 px-3 py-1.5 text-sm text-foreground outline-none transition-colors focus:border-border"
      />
      {loading && (
        <div className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-blue-500/10">
          <div
            className="h-full w-2/5 rounded-full bg-blue-500"
            style={{
              animation: "screencast-bar-slide 1.4s ease-in-out infinite",
            }}
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stream view — owns the WebSocket, renders frames, forwards mouse + scroll.
// ---------------------------------------------------------------------------

interface ScreencastFrameMetadata {
  offsetTop: number;
  pageScaleFactor: number;
  deviceWidth: number;
  deviceHeight: number;
  scrollOffsetX: number;
  scrollOffsetY: number;
  timestamp?: number;
}

interface ScreencastFrame {
  data: string; // base64 JPEG
  metadata: ScreencastFrameMetadata;
  sessionId: number;
}

interface StreamViewProps {
  bandTabId: string;
  visible: boolean;
  /**
   * Set by StreamView when the WS opens; cleared on unmount/close. The
   * parent (StreamPanel) reads it from the AddressBar handlers to
   * dispatch navigation commands without re-opening a WS.
   */
  sendCdpRef: React.MutableRefObject<CdpSender | null>;
  /** Called when the streamed page navigates (`Page.frameNavigated` for
   *  the main frame). Lets the address bar reflect the live URL. */
  onUrlChange: (url: string) => void;
  /** Called as the page transitions through load states. */
  onLoadingChange: (loading: boolean) => void;
  /** Called when CDP-extracted page metadata (title, favicon URL) changes. */
  onPageMetaChange: (meta: { title?: string; favicon?: string | null }) => void;
}

// JS evaluated in the streamed page to extract title + favicon. Picks the
// first explicit <link rel*=icon>; falls back to /favicon.ico relative to
// the document's location. Returned as a plain object via returnByValue.
const PAGE_META_EXPRESSION = `(() => {
  const links = Array.from(document.querySelectorAll('link[rel*="icon" i]'));
  const explicit = links.find((l) => /^(?:shortcut\\s+)?icon$/i.test(l.rel));
  let favicon = explicit ? explicit.href : (links[0] ? links[0].href : null);
  if (!favicon) {
    try { favicon = new URL('/favicon.ico', location.href).href; } catch { favicon = null; }
  }
  return { title: document.title || '', favicon };
})()`;

function StreamView({
  bandTabId,
  visible,
  sendCdpRef,
  onUrlChange,
  onLoadingChange,
  onPageMetaChange,
}: StreamViewProps) {
  const wsRef = useRef<WebSocket | null>(null);
  const nextIdRef = useRef(1);
  const lastMetaRef = useRef<ScreencastFrameMetadata | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  // Map<requestId, callback> for CDP responses we want to handle. Used by
  // the page-metadata fetch below; can be reused for any future request /
  // response CDP method (Page.getNavigationHistory, DOM.getNodeForLocation,
  // etc.). Cleared on unmount.
  const pendingResponsesRef = useRef(
    // biome-ignore lint/suspicious/noExplicitAny: heterogeneous CDP responses
    new Map<number, (result: any, error: { message?: string } | undefined) => void>(),
  );
  const lastMetaFetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const frameCountRef = useRef(0);
  const [fps, setFps] = useState(0);

  const [frameSrc, setFrameSrc] = useState<string | null>(null);
  const [status, setStatus] = useState<"connecting" | "open" | "closed" | "error">("connecting");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const sendCdp = useCallback((method: string, params?: Record<string, unknown>): void => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const id = nextIdRef.current++;
    ws.send(JSON.stringify({ id, method, params: params ?? {} }));
  }, []);

  /**
   * Send a CDP request and run a callback when its response arrives.
   * Fire-and-forget if the WS isn't open (caller handles).
   */
  const sendCdpExpectResponse = useCallback(
    (
      method: string,
      params: Record<string, unknown>,
      // biome-ignore lint/suspicious/noExplicitAny: heterogeneous CDP responses
      onResponse: (result: any, error: { message?: string } | undefined) => void,
    ): void => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const id = nextIdRef.current++;
      pendingResponsesRef.current.set(id, onResponse);
      ws.send(JSON.stringify({ id, method, params }));
    },
    [],
  );

  /**
   * Fetch the streamed page's title + favicon URL via Runtime.evaluate
   * and forward to the parent. Called once on Page.frameNavigated and
   * again ~1.5s later to catch sites that set the title async (analytics,
   * SPA mounting, etc.).
   */
  const fetchPageMeta = useCallback(() => {
    sendCdpExpectResponse(
      "Runtime.evaluate",
      { expression: PAGE_META_EXPRESSION, returnByValue: true },
      (result, error) => {
        if (error) return;
        const value = result?.result?.value as
          | { title?: string; favicon?: string | null }
          | undefined;
        if (!value) return;
        onPageMetaChange({
          title: typeof value.title === "string" ? value.title : undefined,
          favicon: value.favicon ?? null,
        });
      },
    );
  }, [sendCdpExpectResponse, onPageMetaChange]);

  // Open WS, start screencast, ack each frame.
  useEffect(() => {
    if (!visible) return;

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/cdp?bandTabId=${encodeURIComponent(bandTabId)}`;
    const ws = new WebSocket(url);
    wsRef.current = ws;
    sendCdpRef.current = sendCdp;
    setStatus("connecting");
    setErrorMessage(null);

    ws.onopen = () => {
      setStatus("open");
      sendCdp("Page.enable");
      // Wake the chromium compositor for this target. Electron parks the
      // compositor on any WebContentsView whose bounds are outside the
      // parent's clip region. Without `Page.bringToFront`,
      // `Page.startScreencast` emits zero frames.
      sendCdp("Page.bringToFront");
      sendCdp("Page.startScreencast", {
        format: "jpeg",
        quality: 60,
        everyNthFrame: 1,
      });
      // The tab may have already finished loading before we attached
      // (e.g., it was created and navigated by the desktop UI). Fetch
      // the current title + favicon so the dockview tab updates even
      // when no Page.frameNavigated arrives during this WS lifetime.
      fetchPageMeta();
    };

    ws.onmessage = (event) => {
      let msg: {
        method?: string;
        // biome-ignore lint/suspicious/noExplicitAny: heterogeneous CDP event payloads
        params?: any;
        id?: number;
        error?: { message?: string };
      };
      try {
        msg = JSON.parse(event.data as string);
      } catch {
        return;
      }
      // Pending request/response (e.g. our page-meta Runtime.evaluate).
      if (typeof msg.id === "number") {
        const cb = pendingResponsesRef.current.get(msg.id);
        if (cb) {
          pendingResponsesRef.current.delete(msg.id);
          // biome-ignore lint/suspicious/noExplicitAny: heterogeneous CDP responses
          cb((msg as any).result, msg.error);
          return;
        }
      }
      if (msg.error) {
        setErrorMessage(msg.error.message ?? "CDP error");
        return;
      }
      // Live frame.
      if (msg.method === "Page.screencastFrame" && msg.params) {
        const frame = msg.params as ScreencastFrame;
        lastMetaRef.current = frame.metadata;
        setFrameSrc(`data:image/jpeg;base64,${frame.data}`);
        frameCountRef.current += 1;
        sendCdp("Page.screencastFrameAck", { sessionId: frame.sessionId });
        return;
      }
      // The streamed tab navigated (link click, history.back, our own
      // Page.navigate). Reflect the new URL in the address bar AND
      // fetch the latest title + favicon via Runtime.evaluate. We
      // schedule a second fetch ~1.5s later to catch sites that set
      // title async (after analytics / SPA mount).
      if (msg.method === "Page.frameNavigated" && msg.params?.frame) {
        const frame = msg.params.frame as { parentId?: string; url?: string };
        if (!frame.parentId && typeof frame.url === "string") {
          onUrlChange(frame.url);
          fetchPageMeta();
          if (lastMetaFetchTimerRef.current) {
            clearTimeout(lastMetaFetchTimerRef.current);
          }
          lastMetaFetchTimerRef.current = setTimeout(() => {
            lastMetaFetchTimerRef.current = null;
            fetchPageMeta();
          }, 1500);
        }
        return;
      }
      // Loading indicator. We track main-frame loading transitions only
      // since per-subresource events are noisy.
      if (msg.method === "Page.frameStartedLoading") {
        onLoadingChange(true);
        return;
      }
      if (msg.method === "Page.frameStoppedLoading") {
        onLoadingChange(false);
        // Page may have set title later in load — refetch.
        fetchPageMeta();
        return;
      }
    };

    ws.onerror = () => {
      setStatus("error");
    };

    ws.onclose = (ev) => {
      setStatus("closed");
      if (ev.code !== 1000) {
        setErrorMessage(ev.reason || `Connection closed (code ${ev.code})`);
      }
    };

    return () => {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ id: nextIdRef.current++, method: "Page.stopScreencast" }));
        }
        ws.close();
      } catch {
        // best-effort
      }
      wsRef.current = null;
      // Drop the parent's sendCdp handle so navigation buttons no-op
      // until the next WS opens, instead of writing into a closed socket.
      if (sendCdpRef.current === sendCdp) {
        sendCdpRef.current = null;
      }
      if (lastMetaFetchTimerRef.current) {
        clearTimeout(lastMetaFetchTimerRef.current);
        lastMetaFetchTimerRef.current = null;
      }
      pendingResponsesRef.current.clear();
    };
  }, [bandTabId, visible, sendCdp, sendCdpRef, onUrlChange, onLoadingChange, fetchPageMeta]);

  // FPS counter (1Hz).
  useEffect(() => {
    if (!visible) return;
    const id = setInterval(() => {
      setFps(frameCountRef.current);
      frameCountRef.current = 0;
    }, 1000);
    return () => clearInterval(id);
  }, [visible]);

  // ----- Mouse + scroll input forwarding -----

  const dispatchMouse = useCallback(
    (
      type: "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel",
      e: React.MouseEvent | React.WheelEvent,
      extra?: { deltaX?: number; deltaY?: number },
    ) => {
      const img = imgRef.current;
      const meta = lastMetaRef.current;
      if (!img || !meta) return;
      const rect = img.getBoundingClientRect();
      const scaleX = meta.deviceWidth / rect.width;
      const scaleY = meta.deviceHeight / rect.height;
      const x = (e.clientX - rect.left) * scaleX;
      const y = (e.clientY - rect.top) * scaleY - (meta.offsetTop ?? 0);

      const buttonMap: Record<number, "left" | "middle" | "right"> = {
        0: "left",
        1: "middle",
        2: "right",
      };
      const mouseEvent = e as React.MouseEvent;
      const button = type === "mouseWheel" ? "none" : (buttonMap[mouseEvent.button] ?? "left");

      const params: Record<string, unknown> = {
        type,
        x,
        y,
        button,
        clickCount: type === "mousePressed" || type === "mouseReleased" ? 1 : 0,
        modifiers: 0,
      };

      if (type === "mouseWheel") {
        params.deltaX = (extra?.deltaX ?? 0) * scaleX;
        params.deltaY = (extra?.deltaY ?? 0) * scaleY;
      }

      sendCdp("Input.dispatchMouseEvent", params);
    },
    [sendCdp],
  );

  const onMouseDown = (e: React.MouseEvent<HTMLImageElement>) => {
    e.preventDefault();
    dispatchMouse("mousePressed", e);
  };
  const onMouseUp = (e: React.MouseEvent<HTMLImageElement>) => {
    e.preventDefault();
    dispatchMouse("mouseReleased", e);
  };
  const onMouseMove = (e: React.MouseEvent<HTMLImageElement>) => {
    dispatchMouse("mouseMoved", e);
  };
  const onWheel = (e: React.WheelEvent<HTMLImageElement>) => {
    e.preventDefault();
    dispatchMouse("mouseWheel", e, { deltaX: -e.deltaX, deltaY: -e.deltaY });
  };
  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
  };

  const statusLabel = useMemo(() => {
    if (status === "connecting") return "Connecting…";
    if (status === "open") return `${fps} fps`;
    if (status === "closed") return errorMessage ?? "Disconnected";
    return errorMessage ?? "Connection error";
  }, [status, errorMessage, fps]);

  return (
    <>
      {frameSrc ? (
        <img
          ref={imgRef}
          src={frameSrc}
          alt="Live tab"
          className="h-full w-full select-none object-contain"
          draggable={false}
          onMouseDown={onMouseDown}
          onMouseUp={onMouseUp}
          onMouseMove={onMouseMove}
          onWheel={onWheel}
          onContextMenu={onContextMenu}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-sm text-muted-foreground">
          {status === "error" || errorMessage
            ? (errorMessage ?? "Connection error")
            : "Waiting for first frame…"}
        </div>
      )}
      <div className="pointer-events-none absolute right-2 top-2 rounded-full bg-background/80 px-2 py-0.5 text-[10px] font-medium text-muted-foreground shadow-sm backdrop-blur">
        {statusLabel}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Empty / error states
// ---------------------------------------------------------------------------

function EmptyPanel() {
  return (
    <div className="max-w-md rounded-md border border-dashed border-border p-6 text-sm text-muted-foreground">
      <p className="mb-2 font-medium text-foreground">No Band tabs in this workspace.</p>
      <p>Create a browser tab from the desktop app and it will show up here.</p>
    </div>
  );
}

function ErrorPanel({ error }: { error: string }) {
  return (
    <div className="max-w-md rounded-md border border-border bg-muted/30 p-6 text-sm">
      <p className="mb-2 font-medium text-foreground">
        Open the Band desktop app to use the Browser pane
      </p>
      <p className="mb-3 text-muted-foreground">
        Tabs are owned by the Band desktop app — when it's running on the same machine as this
        server, your tabs show up here so you can drive them remotely from the web.
      </p>
      <p className="text-xs text-muted-foreground">{error}</p>
    </div>
  );
}
