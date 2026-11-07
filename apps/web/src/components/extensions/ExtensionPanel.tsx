import type { PanelManifest } from "@band-app/plugin-api";
import { CircleAlert, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { directPluginStreamTarget, directSocketClosed } from "../../lib/direct-worker";
import { HubWebSocket, hubUrl, hubWsUrl } from "../../lib/hub-config";
import { trpc } from "../../lib/trpc-client";
import { readTheme, useThemeUpdates } from "./ExtensionEditor";

interface Props {
  worktreeId: string;
  extensionId: string;
  panel: PanelManifest;
  /** The tab is the selected one in a group that is on screen. */
  visible: boolean;
}

type PanelLayout = "compact" | "regular";

/** Most streams one panel may hold open at once. */
const MAX_STREAMS = 4;

function currentLayout(): PanelLayout {
  return window.matchMedia("(min-width: 1024px)").matches ? "regular" : "compact";
}

/**
 * A worktree panel an extension contributes. The page runs in `<iframe sandbox="allow-scripts">`
 * with an opaque origin and talks to Band over a `MessageChannel` handed over with `band:hello`.
 *
 * Messages from the page: `stream.open { id, name, params }`, `stream.send { id, message }`,
 * `stream.close { id }` and `call { id, method, params }`. Messages to the page: `init`,
 * `stream.opened`, `stream.frame { id, data }` (binary), `stream.message { id, text }`,
 * `stream.closed { id, code, reason }`, `call.result { id, result }`, `call.error { id, message }`,
 * `control { enabled }`, `visible { visible }` and `layout`. Input is always on: the page gets
 * `control { enabled: true }` once its first stream opens, for pages written against the older
 * view-only protocol.
 */
export function ExtensionPanel({ worktreeId, extensionId, panel, visible }: Props) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const portRef = useRef<MessagePort | null>(null);
  const streamsRef = useRef(new Map<string, WebSocket>());
  const controlSentRef = useRef(false);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const closeStreams = useCallback(() => {
    for (const ws of streamsRef.current.values()) ws.close(1000, "closed");
    streamsRef.current.clear();
  }, []);

  const post = useCallback((message: unknown, transfer: Transferable[] = []) => {
    portRef.current?.postMessage(message, transfer);
  }, []);

  const openStream = useCallback(
    (id: string, name: string, params: unknown) => {
      if (streamsRef.current.has(id) || streamsRef.current.size >= MAX_STREAMS) {
        post({ type: "stream.closed", id, code: 4000, reason: "Too many streams" });
        return;
      }
      let cancelled = false;
      // A placeholder holds the id while the direct target is resolved, so a `stream.close`
      // that arrives meanwhile cancels the open.
      const placeholder = {
        readyState: WebSocket.CONNECTING,
        send: () => undefined,
        close: () => {
          cancelled = true;
          if (streamsRef.current.get(id) === (placeholder as unknown as WebSocket)) {
            streamsRef.current.delete(id);
          }
        },
      };
      streamsRef.current.set(id, placeholder as unknown as WebSocket);

      const attach = (ws: WebSocket, direct: boolean) => {
        ws.binaryType = "arraybuffer";
        streamsRef.current.set(id, ws);
        let opened = false;
        ws.addEventListener("open", () => {
          opened = true;
          if (!controlSentRef.current) {
            controlSentRef.current = true;
            post({ type: "control", enabled: true });
          }
          post({ type: "stream.opened", id });
        });
        ws.addEventListener("message", (event) => {
          if (typeof event.data === "string")
            post({ type: "stream.message", id, text: event.data });
          else post({ type: "stream.frame", id, data: event.data as ArrayBuffer }, [event.data]);
        });
        ws.addEventListener("close", (event) => {
          if (streamsRef.current.get(id) !== ws) return;
          streamsRef.current.delete(id);
          // The worker refused, is not there or cannot open the stream: the hub carries it.
          if (direct && directSocketClosed(worktreeId, event, opened) === "fallback") {
            openHub();
            return;
          }
          post({ type: "stream.closed", id, code: event.code, reason: event.reason });
        });
      };

      const openHub = () => {
        const query = new URLSearchParams({ panel: panel.id, name });
        if (params !== undefined) query.set("params", JSON.stringify(params));
        attach(
          new HubWebSocket(
            hubWsUrl(
              `/api/extensions/${encodeURIComponent(extensionId)}/worktrees/${encodeURIComponent(
                worktreeId,
              )}/stream?${query}`,
            ),
          ),
          false,
        );
      };

      // In the desktop app, for a worktree on this Mac's worker, the stream goes to the worker's
      // loopback listener. The service sees the `direct` profile there and `hub` here.
      directPluginStreamTarget(panel.capability, worktreeId, { name, params }).then(
        (target) => {
          if (cancelled) return;
          if (!target) return openHub();
          attach(new WebSocket(target.url, target.protocols), true);
        },
        () => {
          if (!cancelled) openHub();
        },
      );
    },
    [extensionId, panel.capability, panel.id, post, worktreeId],
  );

  const onMessage = useCallback(
    (event: MessageEvent) => {
      const msg = event.data as { type?: unknown; id?: unknown } & Record<string, unknown>;
      if (msg?.type === "ready") {
        setReady(true);
        return;
      }
      if (!msg || typeof msg.type !== "string" || typeof msg.id !== "string") return;
      const id = msg.id;
      switch (msg.type) {
        case "stream.open":
          if (typeof msg.name === "string") openStream(id, msg.name, msg.params);
          break;
        case "stream.send": {
          const ws = streamsRef.current.get(id);
          if (ws?.readyState === WebSocket.OPEN && typeof msg.message === "string") {
            ws.send(msg.message);
          }
          break;
        }
        case "stream.close": {
          const ws = streamsRef.current.get(id);
          // Forget the id first, so the close event cannot start a hub fallback for a closed stream.
          streamsRef.current.delete(id);
          if (ws) {
            ws.close(1000, "closed");
            post({ type: "stream.closed", id, code: 1000, reason: "closed" });
          }
          break;
        }
        case "call":
          if (typeof msg.method === "string") {
            trpc.extensions.panelCall
              .mutate({
                extensionId,
                panelId: panel.id,
                worktreeId,
                method: msg.method,
                params: msg.params,
              })
              .then(
                (reply) => post({ type: "call.result", id, result: reply.result }),
                (err) =>
                  post({
                    type: "call.error",
                    id,
                    message: err instanceof Error ? err.message : String(err),
                  }),
              );
          }
          break;
        default:
          break;
      }
    },
    [extensionId, openStream, panel.id, post, worktreeId],
  );

  const handshake = useCallback(() => {
    const frame = frameRef.current;
    if (!frame?.contentWindow) return;
    portRef.current?.close();
    closeStreams();
    controlSentRef.current = false;
    setReady(false);
    const channel = new MessageChannel();
    channel.port1.onmessage = onMessage;
    portRef.current = channel.port1;
    frame.contentWindow.postMessage({ type: "band:hello", extensionApi: 1 }, "*", [channel.port2]);
    channel.port1.postMessage({
      type: "init",
      worktreeId,
      theme: readTheme(),
      layout: currentLayout(),
      visible: visibleRef.current,
    });
  }, [closeStreams, onMessage, worktreeId]);

  useThemeUpdates(post, ready);

  useEffect(() => {
    post({ type: "visible", visible });
  }, [visible, post]);

  useEffect(() => {
    const query = window.matchMedia("(min-width: 1024px)");
    const onChange = () => post({ type: "layout", layout: currentLayout() });
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [post]);

  useEffect(
    () => () => {
      closeStreams();
      portRef.current?.close();
    },
    [closeStreams],
  );

  const src = hubUrl(`/ext/${encodeURIComponent(extensionId)}/${panel.entry}`);

  return (
    <div
      data-band-leaf-root=""
      tabIndex={-1}
      data-testid="extension-panel"
      data-extension-id={extensionId}
      data-panel-id={panel.id}
      data-ready={ready ? "true" : "false"}
      className="relative flex h-full w-full flex-col overflow-hidden outline-none"
    >
      <div className="relative min-h-0 flex-1">
        <iframe
          ref={frameRef}
          src={src}
          title={panel.label}
          // Scripts only. Never `allow-same-origin`: the frame must not reach Band's cookies, storage or DOM.
          sandbox="allow-scripts"
          onLoad={handshake}
          onError={() => setError("The panel failed to load")}
          className="absolute inset-0 size-full border-0 bg-background"
          data-testid="extension-panel__frame"
        />
        {!ready && !error && (
          <div className="pointer-events-none absolute right-2 top-2 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-label="Loading panel" />
          </div>
        )}
        {error && (
          <div className="absolute right-2 top-2 text-destructive">
            <CircleAlert className="size-4" aria-label="Panel failed to load" />
          </div>
        )}
      </div>
    </div>
  );
}
