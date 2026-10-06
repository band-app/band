import { Button } from "@band-app/ui";
import type RFB from "@novnc/novnc";
import { useCallback, useEffect, useRef, useState } from "react";
import { createHubWebSocket, hubWsUrl } from "../../lib/hub-config";

type Phase = "connecting" | "connected" | "closed";

interface Closed {
  code: number;
  reason: string;
}

/** The hub closes with these when it will not serve the desktop, and a retry would not change that. */
const FINAL_CLOSE_CODES = new Set([4001, 4409, 1008]);
const RECONNECT_DELAYS_MS = [1000, 2000, 5000];

/**
 * A worker's virtual desktop, drawn by noVNC over the hub's `/api/hosts/<id>/desktop` socket.
 * It starts view-only. "Take control" sends the hub an explicit request, and only then does the
 * hub forward keys, mouse and clipboard to the host, so view-only holds even if this page is
 * modified. A new connection is always view-only again.
 */
export function DesktopViewer({ hostId, hostName }: { hostId: string; hostName: string }) {
  const screenRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [phase, setPhase] = useState<Phase>("connecting");
  const [control, setControl] = useState(false);
  const [resolution, setResolution] = useState<string | null>(null);
  const [closed, setClosed] = useState<Closed | null>(null);
  const [attempt, setAttempt] = useState(0);
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
    setResolution(null);
    controlRef.current = false;
    setControl(false);

    const readSize = () => {
      const canvas = screen.querySelector("canvas");
      if (canvas && canvas.width > 0 && canvas.height > 0) {
        setResolution(`${canvas.width}x${canvas.height}`);
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
      rfb.scaleViewport = true;
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
        rfb.focus();
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

  const setMode = useCallback((enabled: boolean) => {
    const ws = wsRef.current;
    const rfb = rfbRef.current;
    if (!ws || !rfb || ws.readyState !== WebSocket.OPEN) return;
    // The request goes first so the hub applies it before any key the pane sends next.
    ws.send(JSON.stringify({ type: "control", enabled }));
    rfb.viewOnly = !enabled;
    controlRef.current = enabled;
    setControl(enabled);
    if (enabled) rfb.focus();
  }, []);

  const status =
    phase === "connected"
      ? control
        ? "Control"
        : "View only"
      : phase === "connecting"
        ? "Connecting"
        : "Disconnected";

  return (
    <div className="flex h-full min-h-0 flex-col gap-2" data-testid="desktop-viewer">
      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <div className="flex min-w-0 items-center gap-2" data-testid="desktop-viewer__status">
          <span className="truncate" data-testid="desktop-viewer__host">
            {hostName}
          </span>
          <span aria-hidden="true">·</span>
          <span data-testid="desktop-viewer__resolution">{resolution ?? "no signal"}</span>
          <span aria-hidden="true">·</span>
          <span data-testid="desktop-viewer__mode" data-mode={control ? "control" : "view"}>
            {status}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {phase === "closed" && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="desktop-viewer__reconnect"
              onClick={() => {
                retriesRef.current = 0;
                setAttempt((n) => n + 1);
              }}
            >
              Reconnect
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant={control ? "secondary" : "outline"}
            aria-pressed={control}
            disabled={phase !== "connected"}
            data-testid="desktop-viewer__control-toggle"
            onClick={() => setMode(!control)}
          >
            {control ? "Release control" : "Take control"}
          </Button>
        </div>
      </div>
      {closed?.reason && (
        <p role="alert" data-testid="desktop-viewer__error" className="text-xs text-destructive">
          {closed.reason}
        </p>
      )}
      <div
        ref={screenRef}
        data-testid="desktop-viewer__screen"
        className="min-h-0 flex-1 overflow-hidden rounded-md border border-border bg-black"
      />
    </div>
  );
}
