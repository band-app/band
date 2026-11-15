import type { PanelManifest } from "@band-app/plugin-api";
import { Popover, PopoverContent, PopoverTrigger } from "@band-app/ui";
import { CircleAlert, Loader2, Waypoints } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { getElectronBridge, invoke } from "../../lib/desktop-ipc";
import {
  directPluginStreamTarget,
  directSocketClosed,
  directUnavailableReason,
} from "../../lib/direct-worker";
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

/** How often a stream that runs through the hub asks whether the direct path works again. */
const DIRECT_RETRY_MS = 15_000;

/** Longest key and value a panel may store (the app's store enforces the same limits). */
const MAX_SECRET_KEY = 200;
const MAX_SECRET_VALUE = 4096;

/** Where a panel's secrets live: the OS keychain in Band.app, nowhere in a browser. */
type SecretsMode = "keychain" | "none";

function currentLayout(): PanelLayout {
  return window.matchMedia("(min-width: 1024px)").matches ? "regular" : "compact";
}

/**
 * A worktree panel an extension contributes. The page runs in `<iframe sandbox="allow-scripts">`
 * with an opaque origin and talks to Band over a `MessageChannel` handed over with `band:hello`.
 *
 * Messages from the page: `stream.open { id, name, params }`, `stream.send { id, message }`,
 * `stream.close { id }`, `call { id, method, params }` and `secret.get | secret.set | secret.delete
 * { id, key, value? }`. `init` carries `secrets: "keychain" | "none"`. Messages to the page: `init`,
 * `stream.opened`, `stream.frame { id, data }` (binary), `stream.message { id, text }`,
 * `stream.closed { id, code, reason }`, `call.result { id, result }`, `call.error { id, message }`,
 * `secret.result { id, value }`, `secret.error { id, message }`,
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
  /** Why each open stream goes through the hub. Empty when every stream is direct. */
  const hubReasonsRef = useRef(new Map<string, string>());
  const [hubReason, setHubReason] = useState<string | null>(null);

  const setVia = useCallback((id: string, reason: string | null) => {
    if (reason === null) hubReasonsRef.current.delete(id);
    else hubReasonsRef.current.set(id, reason);
    setHubReason([...hubReasonsRef.current.values()][0] ?? null);
  }, []);

  const closeStreams = useCallback(() => {
    for (const ws of streamsRef.current.values()) ws.close(1000, "closed");
    streamsRef.current.clear();
    hubReasonsRef.current.clear();
    setHubReason(null);
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

      const wire = (ws: WebSocket, direct: boolean, reason: string | null, announce: boolean) => {
        ws.binaryType = "arraybuffer";
        streamsRef.current.set(id, ws);
        setVia(id, reason);
        let opened = !announce;
        const onOpen = () => {
          opened = true;
          if (!announce) return;
          if (!controlSentRef.current) {
            controlSentRef.current = true;
            post({ type: "control", enabled: true });
          }
          post({ type: "stream.opened", id });
        };
        ws.addEventListener("open", onOpen);
        ws.addEventListener("message", (event) => {
          if (typeof event.data === "string")
            post({ type: "stream.message", id, text: event.data });
          else post({ type: "stream.frame", id, data: event.data as ArrayBuffer }, [event.data]);
        });
        ws.addEventListener("close", (event) => {
          if (streamsRef.current.get(id) !== ws) return;
          streamsRef.current.delete(id);
          setVia(id, null);
          // The worker refused, is not there or cannot open the stream: the hub carries it.
          if (direct && directSocketClosed(worktreeId, event, opened) === "fallback") {
            openHub("The worker's direct stream failed. Direct is tried again shortly.");
            return;
          }
          post({ type: "stream.closed", id, code: event.code, reason: event.reason });
        });
      };

      // A stream on the hub looks for the direct path again, so one failure at open never keeps it
      // there for good. A working direct socket replaces the hub one without telling the page.
      const retryDirect = (hubWs: WebSocket) => {
        const timer = setInterval(() => {
          if (streamsRef.current.get(id) !== hubWs) {
            clearInterval(timer);
            return;
          }
          void directPluginStreamTarget(panel.capability, worktreeId, {
            name,
            params,
            binaryInput: panel.binaryInput,
          }).then(
            (target) => {
              if (!target || streamsRef.current.get(id) !== hubWs) return;
              clearInterval(timer);
              const candidate = new WebSocket(target.url, target.protocols);
              candidate.binaryType = "arraybuffer";
              candidate.addEventListener("open", () => {
                if (streamsRef.current.get(id) !== hubWs) {
                  candidate.close(1000, "closed");
                  return;
                }
                hubWs.close(1000, "moved");
                wire(candidate, true, null, false);
              });
              candidate.addEventListener("close", () => {
                // It never opened: stay on the hub and look again.
                if (streamsRef.current.get(id) === hubWs) retryDirect(hubWs);
              });
            },
            () => undefined,
          );
        }, DIRECT_RETRY_MS);
      };

      const openHub = (reason: string) => {
        const query = new URLSearchParams({ panel: panel.id, name });
        if (params !== undefined) query.set("params", JSON.stringify(params));
        const hubWs = new HubWebSocket(
          hubWsUrl(
            `/api/extensions/${encodeURIComponent(extensionId)}/worktrees/${encodeURIComponent(
              worktreeId,
            )}/stream?${query}`,
          ),
        );
        wire(hubWs, false, reason, true);
        retryDirect(hubWs);
      };

      // In the desktop app, for a worktree on this Mac's worker, the stream goes to the worker's
      // loopback listener. The service sees the `direct` profile there and `hub` here.
      directPluginStreamTarget(panel.capability, worktreeId, {
        name,
        params,
        binaryInput: panel.binaryInput,
      }).then(
        (target) => {
          if (cancelled) return;
          if (!target) {
            void directUnavailableReason(worktreeId).then((reason) => {
              if (!cancelled) openHub(reason);
            });
            return;
          }
          wire(new WebSocket(target.url, target.protocols), true, null, true);
        },
        () => {
          if (!cancelled) openHub("Asking the worker for direct access failed.");
        },
      );
    },
    [extensionId, panel.binaryInput, panel.capability, panel.id, post, setVia, worktreeId],
  );

  const secretsModeRef = useRef<SecretsMode>("none");

  /**
   * `secret.*` from the page. The value goes only to the desktop shell's store, scoped by this
   * extension's id. In a browser `get` answers null and `set` answers an error the page ignores.
   */
  const handleSecret = useCallback(
    async (type: string, id: string, key: unknown, value: unknown) => {
      const fail = (message: string) => post({ type: "secret.error", id, message });
      if (typeof key !== "string" || key.length === 0 || key.length > MAX_SECRET_KEY) {
        fail("Invalid secret key");
        return;
      }
      if (secretsModeRef.current !== "keychain") {
        if (type === "secret.get" || type === "secret.delete") {
          post({ type: "secret.result", id, value: null });
        } else fail("Secrets are not available in this browser");
        return;
      }
      if (type === "secret.set" && (typeof value !== "string" || value.length > MAX_SECRET_VALUE)) {
        fail("Invalid secret value");
        return;
      }
      const channel =
        type === "secret.get"
          ? "panel_secret_get"
          : type === "secret.set"
            ? "panel_secret_set"
            : "panel_secret_delete";
      try {
        const result = await invoke<string | null>(channel, {
          extensionId,
          key,
          ...(type === "secret.set" ? { value } : {}),
        });
        post({
          type: "secret.result",
          id,
          value: type === "secret.get" && typeof result === "string" ? result : null,
        });
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
      }
    },
    [extensionId, post],
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
          if (ws?.readyState === WebSocket.OPEN) {
            if (typeof msg.message === "string") ws.send(msg.message);
            else if (panel.binaryInput && msg.message instanceof ArrayBuffer) ws.send(msg.message);
            else if (panel.binaryInput && ArrayBuffer.isView(msg.message)) {
              const view = msg.message as ArrayBufferView;
              ws.send(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
            }
          }
          break;
        }
        case "stream.close": {
          const ws = streamsRef.current.get(id);
          // Forget the id first, so the close event cannot start a hub fallback for a closed stream.
          streamsRef.current.delete(id);
          setVia(id, null);
          if (ws) {
            ws.close(1000, "closed");
            post({ type: "stream.closed", id, code: 1000, reason: "closed" });
          }
          break;
        }
        case "secret.get":
        case "secret.set":
        case "secret.delete":
          void handleSecret(msg.type, id, msg.key, msg.value);
          break;
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
    [extensionId, handleSecret, openStream, panel.binaryInput, panel.id, post, setVia, worktreeId],
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
    // The store answers before the page can ask: init waits for it. Without the desktop bridge
    // there is nothing to wait for.
    const sendInit = (secrets: SecretsMode) => {
      if (portRef.current !== channel.port1) return;
      secretsModeRef.current = secrets;
      channel.port1.postMessage({
        type: "init",
        worktreeId,
        theme: readTheme(),
        layout: currentLayout(),
        visible: visibleRef.current,
        secrets,
      });
    };
    if (getElectronBridge()) {
      invoke<boolean>("panel_secrets_available").then(
        (ok) => sendInit(ok === true ? "keychain" : "none"),
        () => sendInit("none"),
      );
    } else sendInit("none");
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
          // A panel may offer fullscreen (the Desktop panel does). The frame still has no same-origin access.
          allowFullScreen
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
        {hubReason && (
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label="Streaming via hub"
                data-testid="extension-panel__via-hub"
                className="absolute bottom-2 right-2 flex items-center gap-1 rounded bg-warning-bg px-1.5 py-0.5 text-xs text-warning"
              >
                <Waypoints className="size-3.5" aria-hidden="true" />
                via hub
              </button>
            </PopoverTrigger>
            <PopoverContent
              className="w-64 text-xs text-warning"
              data-testid="extension-panel__via-hub-reason"
            >
              {hubReason}
            </PopoverContent>
          </Popover>
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
