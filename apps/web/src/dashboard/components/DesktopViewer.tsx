import { Button, SegmentedControl, Spinner } from "@band-app/ui";
import type RFB from "@novnc/novnc";
import { Eye, Maximize2, Minimize2, Monitor, MousePointer2, Unplug, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createHubWebSocket, hubWsUrl } from "../../lib/hub-config";

type Phase = "connecting" | "connected" | "closed";

/** `fit` scales the desktop down to the area (never up), `actual` draws it 1:1 and scrolls. */
export type DesktopScaleMode = "fit" | "actual";

interface Closed {
  code: number;
  reason: string;
}

interface Size {
  w: number;
  h: number;
}

/** The hub closes with these when it will not serve the desktop, and a retry would not change that. */
const FINAL_CLOSE_CODES = new Set([4001, 4409, 1008]);
const RECONNECT_DELAYS_MS = [1000, 2000, 5000];

const SCALE_OPTIONS = [
  { value: "fit" as const, label: "Fit", ariaLabel: "Fit" },
  { value: "actual" as const, label: "1:1", ariaLabel: "Actual size" },
];

/**
 * In fit mode noVNC scales only when the desktop is larger than the area. noVNC's own
 * `scaleViewport` would also scale a small desktop up, which blurs it, so a desktop that fits is
 * drawn 1:1 and centred instead.
 */
function needsDownscale(fb: Size | null, area: Size | null): boolean {
  if (!fb || !area || area.w === 0 || area.h === 0) return false;
  return fb.w > area.w || fb.h > area.h;
}

/**
 * A worker's virtual desktop, drawn by noVNC over the hub's `/api/hosts/<id>/desktop` socket.
 * It starts view-only. "Take control" sends the hub an explicit request, and only then does the
 * hub forward keys, mouse and clipboard to the host, so view-only holds even if this page is
 * modified. A new connection is always view-only again. The keyboard goes to the desktop only
 * in control mode: in view-only mode the canvas never takes focus.
 */
export function DesktopViewer({
  hostId,
  hostName,
  onClose,
}: {
  hostId: string;
  hostName: string;
  onClose?: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [phase, setPhase] = useState<Phase>("connecting");
  const [control, setControl] = useState(false);
  const [framebuffer, setFramebuffer] = useState<Size | null>(null);
  const [area, setArea] = useState<Size | null>(null);
  const [scaleMode, setScaleMode] = useState<DesktopScaleMode>("fit");
  const [fullscreen, setFullscreen] = useState(false);
  const [closed, setClosed] = useState<Closed | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const controlRef = useRef(false);
  const retriesRef = useRef(0);

  useEffect(() => {
    const screen = screenRef.current;
    if (!screen) return;
    // `attempt` restarts the connection: reconnect after a drop or a click on Reconnect.
    void attempt;
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let sizeObserver: MutationObserver | undefined;

    setPhase("connecting");
    setClosed(null);
    setRetrying(false);
    setFramebuffer(null);
    controlRef.current = false;
    setControl(false);

    const readSize = () => {
      const canvas = screen.querySelector("canvas");
      if (canvas && canvas.width > 0 && canvas.height > 0) {
        const w = canvas.width;
        const h = canvas.height;
        setFramebuffer((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
      }
    };

    // noVNC reads `window` when it loads, so it cannot be imported during the server prerender.
    // The socket opens only after the import, because a frame that arrives before noVNC
    // attaches its listener would be lost.
    void import("@novnc/novnc").then(({ default: RFBClass }) => {
      if (disposed) return;
      const ws = createHubWebSocket(hubWsUrl(`/api/hosts/${encodeURIComponent(hostId)}/desktop`), [
        "binary",
      ]);
      wsRef.current = ws;
      const rfb = new RFBClass(screen, ws, { shared: true });
      rfb.viewOnly = true;
      rfb.focusOnClick = false;
      rfb.background = "transparent";
      rfbRef.current = rfb;
      rfb.addEventListener("connect", () => {
        setPhase("connected");
        retriesRef.current = 0;
        readSize();
        const canvas = screen.querySelector("canvas");
        if (canvas) {
          sizeObserver = new MutationObserver(readSize);
          sizeObserver.observe(canvas, { attributes: true, attributeFilter: ["width", "height"] });
        }
      });
      ws.addEventListener("close", (event) => {
        if (disposed) return;
        setClosed({ code: event.code, reason: event.reason });
        setPhase("closed");
        controlRef.current = false;
        setControl(false);
        const delay = RECONNECT_DELAYS_MS[retriesRef.current];
        if (!FINAL_CLOSE_CODES.has(event.code) && delay !== undefined) {
          retriesRef.current += 1;
          setRetrying(true);
          retryTimer = setTimeout(() => setAttempt((n) => n + 1), delay);
        }
      });
    });

    const onPaste = (event: ClipboardEvent) => {
      if (!controlRef.current) return;
      const text = event.clipboardData?.getData("text/plain");
      if (text) rfbRef.current?.clipboardPasteFrom(text);
    };
    screen.addEventListener("paste", onPaste);

    return () => {
      disposed = true;
      clearTimeout(retryTimer);
      sizeObserver?.disconnect();
      screen.removeEventListener("paste", onPaste);
      try {
        rfbRef.current?.disconnect();
      } catch {
        // Already closed.
      }
      rfbRef.current = null;
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [hostId, attempt]);

  // The area the desktop is drawn in, which changes with the window and with fullscreen.
  useEffect(() => {
    const screen = screenRef.current;
    if (!screen) return;
    const observer = new ResizeObserver(([entry]) => {
      const w = Math.floor(entry.contentRect.width);
      const h = Math.floor(entry.contentRect.height);
      setArea((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
    });
    observer.observe(screen);
    return () => observer.disconnect();
  }, []);

  // noVNC measures the area with `getBoundingClientRect`, which a dialog's zoom-in animation
  // shrinks, and a ResizeObserver does not see a transform end. So the scale is applied again
  // when an animation of an element around the viewer ends.
  const [settled, setSettled] = useState(0);
  useEffect(() => {
    const onAnimationEnd = (event: AnimationEvent) => {
      if (event.target instanceof Node && event.target.contains(rootRef.current)) {
        setSettled((n) => n + 1);
      }
    };
    document.addEventListener("animationend", onAnimationEnd, true);
    return () => document.removeEventListener("animationend", onAnimationEnd, true);
  }, []);

  const downscale = scaleMode === "fit" && needsDownscale(framebuffer, area);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `area` and `settled` re-run the scale when the area's size changes, which noVNC only notices for window resizes.
  useEffect(() => {
    const rfb = rfbRef.current;
    if (!rfb || phase !== "connected") return;
    // Clipping stays off: in 1:1 the screen element scrolls natively over the full canvas.
    rfb.clipViewport = false;
    // Setting the same value again makes noVNC rescale to the current area.
    rfb.scaleViewport = !downscale;
    rfb.scaleViewport = downscale;
  }, [downscale, phase, area, settled]);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void rootRef.current?.requestFullscreen();
  }, []);

  const setMode = useCallback((enabled: boolean) => {
    const ws = wsRef.current;
    const rfb = rfbRef.current;
    if (!ws || !rfb || ws.readyState !== WebSocket.OPEN) return;
    // The request goes first so the hub applies it before any key the pane sends next.
    ws.send(JSON.stringify({ type: "control", enabled }));
    rfb.viewOnly = !enabled;
    rfb.focusOnClick = enabled;
    controlRef.current = enabled;
    setControl(enabled);
    if (enabled) rfb.focus();
    else rfb.blur();
  }, []);

  const reconnect = () => {
    retriesRef.current = 0;
    setAttempt((n) => n + 1);
  };

  const status =
    phase === "connected"
      ? control
        ? "In control"
        : "View only"
      : phase === "connecting"
        ? "Connecting"
        : "Disconnected";

  return (
    <div
      ref={rootRef}
      className="flex h-full min-h-0 w-full flex-col bg-background"
      data-testid="desktop-viewer"
      data-control={control ? "true" : "false"}
      data-fullscreen={fullscreen ? "true" : "false"}
      data-scale={scaleMode}
    >
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-border px-3">
        <div
          className="flex min-w-0 flex-1 items-center gap-2 text-xs"
          data-testid="desktop-viewer__status"
        >
          <Monitor className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span
            className="truncate text-sm font-medium text-foreground"
            data-testid="desktop-viewer__host"
          >
            {hostName}
          </span>
          <span
            className="shrink-0 font-mono text-muted-foreground tabular-nums"
            data-testid="desktop-viewer__resolution"
          >
            {framebuffer ? `${framebuffer.w}x${framebuffer.h}` : "no signal"}
          </span>
          <ModeBadge phase={phase} control={control} label={status} />
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <SegmentedControl
            size="sm"
            ariaLabel="Scale"
            options={SCALE_OPTIONS}
            value={scaleMode}
            onChange={setScaleMode}
            className="bg-muted"
          />
          <Button
            type="button"
            size="xs"
            variant={control ? "default" : "outline"}
            aria-pressed={control}
            disabled={phase !== "connected"}
            data-testid="desktop-viewer__control-toggle"
            onClick={() => setMode(!control)}
          >
            <MousePointer2 />
            {control ? "Release" : "Take control"}
          </Button>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
            aria-pressed={fullscreen}
            data-testid="desktop-viewer__fullscreen"
            onClick={toggleFullscreen}
          >
            {fullscreen ? <Minimize2 /> : <Maximize2 />}
          </Button>
          {onClose && (
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label="Close desktop"
              data-testid="desktop-viewer__close"
              onClick={() => {
                if (document.fullscreenElement) void document.exitFullscreen();
                onClose();
              }}
            >
              <X />
            </Button>
          )}
        </div>
      </div>
      <div className="relative min-h-0 flex-1 bg-neutral-950">
        <div ref={screenRef} data-testid="desktop-viewer__screen" className="absolute inset-0" />
        {phase === "connecting" && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 text-sm text-neutral-400">
            <Spinner className="size-5" />
            <span>Connecting to {hostName}</span>
          </div>
        )}
        {phase === "closed" && (
          <div className="absolute inset-0 flex items-center justify-center bg-neutral-950/85 p-6">
            <div className="flex max-w-sm flex-col items-center gap-3 text-center">
              <Unplug className="size-6 text-neutral-400" aria-hidden="true" />
              <p className="text-sm font-medium text-neutral-100">Disconnected</p>
              {closed?.reason && (
                <p
                  role="alert"
                  data-testid="desktop-viewer__error"
                  className="text-xs text-neutral-400"
                >
                  {closed.reason}
                </p>
              )}
              {retrying ? (
                <p className="flex items-center gap-2 text-xs text-neutral-400">
                  <Spinner className="size-3.5" />
                  Reconnecting
                </p>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  data-testid="desktop-viewer__reconnect"
                  onClick={reconnect}
                >
                  Reconnect
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ModeBadge({ phase, control, label }: { phase: Phase; control: boolean; label: string }) {
  const tone =
    phase === "closed"
      ? "border-destructive/30 bg-destructive/10 text-destructive"
      : phase === "connecting"
        ? "border-border bg-muted text-muted-foreground"
        : control
          ? "border-amber-500/40 bg-amber-500/15 text-amber-700 dark:text-amber-300"
          : "border-border bg-muted text-muted-foreground";
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${tone}`}
      data-testid="desktop-viewer__mode"
      data-mode={control ? "control" : "view"}
      data-phase={phase}
    >
      {phase === "connecting" ? (
        <Spinner className="size-3" />
      ) : phase === "closed" ? (
        <Unplug className="size-3" aria-hidden="true" />
      ) : control ? (
        <MousePointer2 className="size-3" aria-hidden="true" />
      ) : (
        <Eye className="size-3" aria-hidden="true" />
      )}
      {label}
    </span>
  );
}
