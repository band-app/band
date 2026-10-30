import type {
  RemoteScreenApi,
  RemoteScreenInfo,
  RemoteScreenProps,
} from "@band-app/plugin-api/client";
import { Popover, PopoverContent, PopoverTrigger } from "@band-app/ui";
import { Camera, CircleAlert, Hand, Pointer } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { HubWebSocket, hubWsUrl } from "../../lib/hub-config";

/** Waits before each reconnect after the stream drops. A fourth drop stays closed. */
const RECONNECT_DELAYS_MS = [500, 1500, 4000];

/** Close codes the hub sends when retrying cannot help (4001: the worker cannot open the stream). */
const FINAL_CLOSE_CODES = new Set([4001, 1008]);

type Phase = "connecting" | "live" | "closed";

const NAMED_KEYS = new Set(["Enter", "Backspace", "Tab", "Escape"]);

/**
 * A live remote screen served by a plugin's stream (`/api/plugins/<id>/worktrees/<worktree>/stream`).
 * Binary messages are JPEG frames, drawn on a canvas. Text messages are JSON; `{"type":"info"}`
 * describes the screen. The viewer starts view-only: pointer and key events are sent only after
 * Take control, which asks the hub to stop dropping them. The stream stays connected while the
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
  const retriesRef = useRef(0);

  useEffect(() => {
    // `attempt` re-runs this effect to reconnect.
    void attempt;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setPhase("connecting");
    const ws = new HubWebSocket(
      hubWsUrl(`/api/plugins/${pluginId}/worktrees/${encodeURIComponent(worktreeId)}/stream`),
    );
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;
    let drawing = false;
    let pending: ArrayBuffer | null = null;
    const draw = async () => {
      if (drawing) return;
      drawing = true;
      try {
        while (pending && !disposed) {
          const bytes = pending;
          pending = null;
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
    ws.addEventListener("open", () => {
      retriesRef.current = 0;
    });
    ws.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        try {
          const msg = JSON.parse(event.data) as { type?: string } & RemoteScreenInfo;
          if (msg.type === "info") setInfo(msg);
        } catch {
          // Not JSON: ignored.
        }
        return;
      }
      pending = event.data as ArrayBuffer;
      void draw();
    });
    ws.addEventListener("close", (event) => {
      if (disposed) return;
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
    return () => {
      disposed = true;
      clearTimeout(timer);
      wsRef.current = null;
      ws.close();
    };
  }, [pluginId, worktreeId, attempt]);

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
