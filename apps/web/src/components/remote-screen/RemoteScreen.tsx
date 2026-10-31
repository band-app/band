import type {
  RemoteScreenApi,
  RemoteScreenInfo,
  RemoteScreenProps,
} from "@band-app/plugin-api/client";
import { Popover, PopoverContent, PopoverTrigger } from "@band-app/ui";
import { Camera, CircleAlert, Hand, Pointer } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type DirectSocketTarget,
  directPluginStreamTarget,
  directSocketClosed,
} from "../../lib/direct-worker";
import { HubWebSocket, hubWsUrl } from "../../lib/hub-config";

/** Waits before each reconnect after the stream drops. A fourth drop stays closed. */
const RECONNECT_DELAYS_MS = [500, 1500, 4000];

/** Close codes the hub sends when retrying cannot help (4001: the worker cannot open the stream). */
const FINAL_CLOSE_CODES = new Set([4001, 1008]);

type Phase = "connecting" | "live" | "closed";
/** Which way the frames come: from this computer's worker on loopback, or through the hub. */
type Route = "direct" | "hub";

const NAMED_KEYS = new Set(["Enter", "Backspace", "Tab", "Escape"]);

/**
 * A live remote screen served by a plugin's stream (`/api/plugins/<id>/worktrees/<worktree>/stream`).
 * Binary messages are JPEG frames, drawn on a canvas. Text messages are JSON; `{"type":"info"}`
 * describes the screen. The viewer starts view-only: pointer and key events are sent only after
 * Take control, which asks the hub (or the worker, on the direct path) to stop dropping them.
 * In the desktop app, a worktree on this computer's own worker streams from that worker on
 * `127.0.0.1` with full-size frames. Any refusal or failure to connect falls back to the hub at
 * once, which sends smaller frames, and the direct path is tried again after a rest
 * (`direct-worker.ts`). The stream stays connected while the
 * tab is hidden. Pointer positions are sent as 0..1 fractions of the screen, so the plugin maps
 * them to its own units.
 */
export function RemoteScreen({ pluginId, worktreeId, visible, title, actions }: RemoteScreenProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const controllingRef = useRef(false);
  const pressedRef = useRef(false);
  const [phase, setPhase] = useState<Phase>("connecting");
  const [closeReason, setCloseReason] = useState<string | null>(null);
  const [controlling, setControlling] = useState(false);
  const [info, setInfo] = useState<RemoteScreenInfo | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [route, setRoute] = useState<Route | null>(null);
  const retriesRef = useRef(0);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const pendingRef = useRef<ArrayBuffer | null>(null);

  useEffect(() => {
    // `attempt` re-runs this effect to reconnect.
    void attempt;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ws: WebSocket | null = null;
    setPhase("connecting");
    const hubUrl = hubWsUrl(
      `/api/plugins/${pluginId}/worktrees/${encodeURIComponent(worktreeId)}/stream`,
    );
    let drawing = false;
    const draw = async () => {
      // A hidden tab keeps the newest frame and decodes it when it is shown again.
      if (drawing || !visibleRef.current) return;
      drawing = true;
      try {
        while (pendingRef.current && !disposed && visibleRef.current) {
          const bytes = pendingRef.current;
          pendingRef.current = null;
          const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
          const canvas = canvasRef.current;
          if (canvas) {
            if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
              canvas.width = bitmap.width;
              canvas.height = bitmap.height;
            }
            canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
          }
          bitmap.close();
          setPhase("live");
        }
      } catch {
        // A frame that does not decode is skipped.
      } finally {
        drawing = false;
      }
    };

    /** Opens the socket: to this computer's worker when `direct` is set, else to the hub. */
    const open = (direct: DirectSocketTarget | null) => {
      if (disposed) return;
      const sock = direct ? new WebSocket(direct.url, direct.protocols) : new HubWebSocket(hubUrl);
      sock.binaryType = "arraybuffer";
      ws = sock;
      wsRef.current = sock;
      setRoute(direct ? "direct" : "hub");
      let opened = false;
      sock.addEventListener("open", () => {
        opened = true;
        retriesRef.current = 0;
      });
      sock.addEventListener("message", (event) => {
        if (ws !== sock) return;
        if (typeof event.data === "string") {
          try {
            const msg = JSON.parse(event.data) as { type?: string } & RemoteScreenInfo;
            if (msg.type === "info") setInfo(msg);
          } catch {
            // Not JSON: ignored.
          }
          return;
        }
        pendingRef.current = event.data as ArrayBuffer;
        void draw();
      });
      sock.addEventListener("close", (event) => {
        if (disposed || ws !== sock) return;
        // The worker refused, is not there, or cannot open the stream: the hub carries it instead.
        if (direct && directSocketClosed(worktreeId, event, opened) === "fallback") {
          // The hub's socket starts view-only, so a control taken on the worker is over.
          controllingRef.current = false;
          pressedRef.current = false;
          setControlling(false);
          open(null);
          return;
        }
        setPhase("closed");
        setCloseReason(event.reason || null);
        controllingRef.current = false;
        pressedRef.current = false;
        setControlling(false);
        const delay = RECONNECT_DELAYS_MS[retriesRef.current];
        if (!FINAL_CLOSE_CODES.has(event.code) && delay !== undefined) {
          retriesRef.current += 1;
          timer = setTimeout(() => setAttempt((n) => n + 1), delay);
        }
      });
    };
    directPluginStreamTarget(pluginId, worktreeId).then(open, () => open(null));
    return () => {
      disposed = true;
      clearTimeout(timer);
      wsRef.current = null;
      ws?.close();
    };
  }, [pluginId, worktreeId, attempt]);

  // Showing the tab again draws the frame that arrived while it was hidden.
  useEffect(() => {
    if (!visible || !pendingRef.current) return;
    const canvas = canvasRef.current;
    const bytes = pendingRef.current;
    pendingRef.current = null;
    void createImageBitmap(new Blob([bytes], { type: "image/jpeg" })).then((bitmap) => {
      if (canvas) {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
      }
      bitmap.close();
    });
  }, [visible]);

  const reconnect = useCallback(() => {
    retriesRef.current = 0;
    setCloseReason(null);
    setAttempt((n) => n + 1);
  }, []);

  const send = useCallback((message: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }, []);

  const setControl = useCallback(
    (enabled: boolean) => {
      send({ type: "control", enabled });
      controllingRef.current = enabled;
      setControlling(enabled);
      if (enabled) canvasRef.current?.focus();
    },
    [send],
  );

  const touch = useCallback(
    (phaseName: "begin" | "move" | "end", e: React.PointerEvent<HTMLCanvasElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
      const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
      send({ type: "touch", phase: phaseName, x, y });
    },
    [send],
  );

  const screenshot = useCallback(() => {
    canvasRef.current?.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${pluginId}-screenshot.png`;
      a.click();
      URL.revokeObjectURL(url);
    }, "image/png");
  }, [pluginId]);

  const api: RemoteScreenApi = { send, controlling, info };
  const deviceName = typeof info?.name === "string" ? info.name : null;

  return (
    <div
      className="flex h-full w-full flex-col overflow-hidden bg-background outline-none"
      data-band-leaf-root=""
      data-testid="remote-screen"
      data-phase={phase}
      data-route={route ?? "pending"}
      data-controlling={controlling ? "true" : "false"}
      data-visible={visible ? "true" : "false"}
    >
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
        <span className="truncate text-xs text-foreground">{deviceName ?? title}</span>
        <span
          className="truncate text-xs text-muted-foreground"
          data-testid="remote-screen__status"
        >
          {phase === "live" ? (controlling ? "Controlling" : "View only") : phase}
        </span>
        {phase === "closed" && closeReason && (
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label="Why the screen is closed"
                data-testid="remote-screen__error"
                className="inline-flex size-6 items-center justify-center rounded text-destructive"
              >
                <CircleAlert className="size-3.5" />
              </button>
            </PopoverTrigger>
            <PopoverContent className="text-xs">{closeReason}</PopoverContent>
          </Popover>
        )}
        {phase === "closed" && (
          <button
            type="button"
            data-testid="remote-screen__reconnect"
            onClick={reconnect}
            className="inline-flex h-6 items-center rounded px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            Reconnect
          </button>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          {actions?.(api)}
          <button
            type="button"
            aria-label="Screenshot"
            title="Save a screenshot"
            disabled={phase !== "live"}
            data-testid="remote-screen__screenshot"
            onClick={screenshot}
            className="inline-flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
          >
            <Camera className="size-3.5" />
          </button>
          <button
            type="button"
            disabled={phase !== "live"}
            data-testid="remote-screen__control"
            onClick={() => setControl(!controlling)}
            className="inline-flex h-7 items-center gap-1 rounded px-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
          >
            {controlling ? <Hand className="size-3.5" /> : <Pointer className="size-3.5" />}
            {controlling ? "Release" : "Take control"}
          </button>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-2">
        <canvas
          ref={canvasRef}
          tabIndex={0}
          data-testid="remote-screen__canvas"
          aria-label={title}
          className="max-h-full max-w-full rounded-md border border-border object-contain outline-none"
          style={{ touchAction: "none", cursor: controlling ? "pointer" : "default" }}
          onPointerDown={(e) => {
            if (!controllingRef.current) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            pressedRef.current = true;
            touch("begin", e);
          }}
          onPointerMove={(e) => {
            if (controllingRef.current && pressedRef.current) touch("move", e);
          }}
          onPointerUp={(e) => {
            if (!controllingRef.current || !pressedRef.current) return;
            pressedRef.current = false;
            touch("end", e);
          }}
          onPointerCancel={(e) => {
            if (!controllingRef.current || !pressedRef.current) return;
            pressedRef.current = false;
            touch("end", e);
          }}
          onKeyDown={(e) => {
            if (!controllingRef.current || e.metaKey || e.ctrlKey || e.altKey) return;
            if (NAMED_KEYS.has(e.key)) {
              e.preventDefault();
              send({ type: "key", key: e.key });
            } else if (e.key.length === 1) {
              e.preventDefault();
              send({ type: "text", text: e.key });
            }
          }}
        />
      </div>
    </div>
  );
}
