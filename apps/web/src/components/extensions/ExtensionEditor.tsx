import type { FileEditorManifest } from "@band-app/plugin-api";
import { Button, Popover, PopoverContent, PopoverTrigger } from "@band-app/ui";
import { CircleAlert, Loader2, Save } from "lucide-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { useAdapter } from "../../dashboard/context";
import { useIsDesktop } from "../../hooks/useIsDesktop";
import { getClientId } from "../../lib/activity-reporter";
import { fileName, setExtensionDirty } from "../../lib/extensions";
import { hubFetch, hubUrl } from "../../lib/hub-config";
import { isDesktop } from "../../lib/is-desktop";
import { trpc } from "../../lib/trpc-client";

/** What a caller (the agent tools, later) can do with an open editor tab. */
export interface ExtensionEditorHandle {
  /** Sends one MCP JSON-RPC request to the editor and resolves with its answer (matched by `id`). */
  mcp(message: { id: string | number; [key: string]: unknown }): Promise<unknown>;
}

interface Props {
  worktreeId: string;
  filePath: string;
  extensionId: string;
  editor: FileEditorManifest;
  /** The tab is the selected one in a group that is on screen. */
  visible: boolean;
  /** Forces the compact layout (the iOS embed route). Otherwise it follows the viewport. */
  compact?: boolean;
}

/** How often the tab tells the hub it is still open, so a hub restart does not lose it. */
const REGISTER_KEEPALIVE_MS = 60_000;

type EditorLayout = "compact" | "regular";

/** The selection an editor reports. Anything that is not shaped like one is dropped. */
function parseSelection(value: unknown): {
  address: string;
  kind: string;
  label: string;
  text?: string;
  rect?: { x: number; y: number; width: number; height: number };
} | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.address !== "string" || typeof v.kind !== "string" || typeof v.label !== "string") {
    return null;
  }
  const rect = v.rect as Record<string, unknown> | undefined;
  const validRect =
    rect &&
    ["x", "y", "width", "height"].every(
      (k) => typeof rect[k] === "number" && Number.isFinite(rect[k] as number),
    );
  return {
    address: v.address.slice(0, 1000),
    kind: v.kind.slice(0, 64),
    label: v.label.slice(0, 300),
    ...(typeof v.text === "string" ? { text: v.text } : {}),
    ...(validRect
      ? { rect: rect as unknown as { x: number; y: number; width: number; height: number } }
      : {}),
  };
}

const MCP_TIMEOUT_MS = 60_000;

/** The semantic tokens an editor may read to match Band's look (CSS variables, without `--`). */
const THEME_TOKENS = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "border",
  "input",
  "ring",
  "selection",
  "link",
] as const;

function readTheme(): { mode: "dark" | "light"; tokens: Record<string, string> } {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  const tokens: Record<string, string> = {};
  for (const name of THEME_TOKENS) {
    const value = style.getPropertyValue(`--${name}`).trim();
    if (value) tokens[name] = value;
  }
  return { mode: root.classList.contains("dark") ? "dark" : "light", tokens };
}

const MIME_BY_EXT: Record<string, string> = {
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".csv": "text/csv",
  ".txt": "text/plain",
  ".json": "application/json",
};

function mimeFor(name: string): string {
  const dot = name.lastIndexOf(".");
  return (dot >= 0 && MIME_BY_EXT[name.slice(dot).toLowerCase()]) || "application/octet-stream";
}

function fileRoute(worktreeId: string, filePath: string): string {
  return `/api/worktree-file/${encodeURIComponent(worktreeId)}/${filePath
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

function parentDirOf(path: string): string {
  const normalised = path.split(/[\\/]+/).join("/");
  const idx = normalised.lastIndexOf("/");
  return idx === -1 ? "" : normalised.slice(0, idx);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

function toBytes(value: unknown): Uint8Array | null {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

/**
 * One file open in an extension's editor. The editor runs in `<iframe sandbox="allow-scripts">`
 * with an opaque origin, so it holds no Band cookie, token or storage. The tab speaks to it over
 * a `MessageChannel` it hands over with `band:hello`.
 */
export const ExtensionEditor = forwardRef<ExtensionEditorHandle, Props>(function ExtensionEditor(
  { worktreeId, filePath, extensionId, editor, visible, compact },
  ref,
) {
  const adapter = useAdapter();
  const wide = useIsDesktop();
  const layout: EditorLayout = compact === true || !(wide || isDesktop) ? "compact" : "regular";
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const frameRef = useRef<HTMLIFrameElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const portRef = useRef<MessagePort | null>(null);
  /** The bytes the file had when this tab last read or wrote it. */
  const knownRef = useRef<Uint8Array | null>(null);
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const checkingRef = useRef(false);
  const recheckRef = useRef(false);
  const pendingMcp = useRef(
    new Map<
      string | number,
      { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: number }
    >(),
  );
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** The file changed on disk while this tab has unsaved edits. */
  const [conflict, setConflict] = useState<Uint8Array | null>(null);
  const [dirty, setDirty] = useState(false);

  const fetchBytes = useCallback(async (): Promise<Uint8Array> => {
    const res = await hubFetch(fileRoute(worktreeId, filePath));
    if (!res.ok) throw new Error(`Could not read the file (${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  }, [worktreeId, filePath]);

  // The bytes for the first `init`, fetched while the frame loads. A frame that reloads later
  // gets a fresh read.
  const initialRef = useRef<Promise<Uint8Array> | null>(null);
  useEffect(() => {
    const pending = fetchBytes();
    initialRef.current = pending;
    pending.catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [fetchBytes]);

  const markDirty = useCallback(
    (dirty: boolean) => {
      dirtyRef.current = dirty;
      setDirty(dirty);
      setExtensionDirty(worktreeId, filePath, dirty);
    },
    [worktreeId, filePath],
  );

  const post = useCallback((message: unknown, transfer: Transferable[] = []) => {
    portRef.current?.postMessage(message, transfer);
  }, []);

  const save = useCallback(
    async (bytes: Uint8Array) => {
      savingRef.current = true;
      // The file watch reports our own write too; knowing the bytes keeps it from reading as a change.
      const before = knownRef.current;
      knownRef.current = bytes.slice();
      setSaveError(null);
      try {
        const res = await hubFetch(fileRoute(worktreeId, filePath), {
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream" },
          body: bytes.slice().buffer,
        });
        if (!res.ok) throw new Error(`Save failed (${res.status})`);
        markDirty(false);
        setConflict(null);
        post({ type: "saved" });
      } catch (err) {
        knownRef.current = before;
        const message = err instanceof Error ? err.message : String(err);
        setSaveError(message);
        post({ type: "saveFailed", error: message });
      } finally {
        savingRef.current = false;
      }
    },
    [worktreeId, filePath, markDirty, post],
  );

  const checkDisk = useCallback(async () => {
    if (!portRef.current) return;
    if (savingRef.current || checkingRef.current) {
      recheckRef.current = true;
      return;
    }
    checkingRef.current = true;
    try {
      const bytes = await fetchBytes();
      const known = knownRef.current;
      if (known && sameBytes(known, bytes)) return;
      if (dirtyRef.current) {
        setConflict(bytes);
        return;
      }
      knownRef.current = bytes.slice();
      const copy = bytes.slice().buffer;
      post({ type: "reload", bytes: copy }, [copy]);
    } catch {
      // A file that is gone or unreadable right now keeps the document on screen.
    } finally {
      checkingRef.current = false;
      if (recheckRef.current) {
        recheckRef.current = false;
        void checkDisk();
      }
    }
  }, [fetchBytes, post]);

  const onMessage = useCallback(
    (event: MessageEvent) => {
      const data = event.data as { type?: string; [key: string]: unknown } | null;
      if (!data || typeof data.type !== "string") return;
      switch (data.type) {
        case "ready":
          setReady(true);
          break;
        case "dirty":
          markDirty(data.dirty === true);
          break;
        case "save": {
          const bytes = toBytes(data.bytes);
          if (bytes) void save(bytes);
          break;
        }
        case "selection": {
          const selection = data.selection === null ? null : parseSelection(data.selection);
          if (data.selection !== null && selection === null) break;
          trpc.editors.setSelection
            .mutate({
              clientId: getClientId(),
              worktreeId,
              file: filePath,
              extensionId,
              editorId: editor.id,
              selection,
            })
            .catch(() => {});
          break;
        }
        case "mcp": {
          const message = data.message as { id?: string | number } | undefined;
          const entry = message?.id !== undefined ? pendingMcp.current.get(message.id) : undefined;
          if (entry && message?.id !== undefined) {
            window.clearTimeout(entry.timer);
            pendingMcp.current.delete(message.id);
            entry.resolve(message);
          }
          break;
        }
        default:
          break;
      }
    },
    [markDirty, save, worktreeId, filePath, extensionId, editor.id],
  );

  const handshake = useCallback(async () => {
    const frame = frameRef.current;
    if (!frame?.contentWindow) return;
    portRef.current?.close();
    setReady(false);
    const channel = new MessageChannel();
    channel.port1.onmessage = onMessage;
    portRef.current = channel.port1;
    frame.contentWindow.postMessage({ type: "band:hello", extensionApi: 1 }, "*", [channel.port2]);
    try {
      const pending = initialRef.current ?? fetchBytes();
      initialRef.current = null;
      const bytes = await pending;
      knownRef.current = bytes.slice();
      const copy = bytes.slice().buffer;
      const name = fileName(filePath);
      channel.port1.postMessage(
        {
          type: "init",
          file: { name, path: filePath, mime: mimeFor(name), bytes: copy, readOnly: false },
          theme: readTheme(),
          layout: layoutRef.current,
        },
        [copy],
      );
    } catch {
      // The prefetch already reported the failure.
    }
  }, [filePath, fetchBytes, onMessage]);

  const mcp = useCallback(
    (message: { id: string | number; [key: string]: unknown }): Promise<unknown> =>
      new Promise((resolve, reject) => {
        if (!portRef.current) {
          reject(new Error("The editor is not ready"));
          return;
        }
        const timer = window.setTimeout(() => {
          pendingMcp.current.delete(message.id);
          reject(new Error("The editor did not answer in time"));
        }, MCP_TIMEOUT_MS);
        pendingMcp.current.set(message.id, { resolve, reject, timer });
        portRef.current.postMessage({ type: "mcp", message });
      }),
    [],
  );

  useImperativeHandle(ref, () => ({ mcp }), [mcp]);

  // Tell the editor when the layout changes (a window resized to or from phone width).
  useEffect(() => {
    if (ready) post({ type: "layout", layout });
  }, [ready, layout, post]);

  // Agent access: the hub knows this tab while it is ready and open, and sends it editor calls.
  const tabIdentity = useCallback(
    () => ({
      clientId: getClientId(),
      worktreeId,
      file: filePath,
      extensionId,
      editorId: editor.id,
    }),
    [worktreeId, filePath, extensionId, editor.id],
  );
  useEffect(() => {
    if (!ready) return;
    const identity = tabIdentity();
    const register = () =>
      void trpc.editors.register.mutate({ ...identity, dirty: dirtyRef.current }).catch(() => {});
    register();
    const timer = window.setInterval(register, REGISTER_KEEPALIVE_MS);
    return () => {
      window.clearInterval(timer);
      void trpc.editors.unregister
        .mutate({
          clientId: identity.clientId,
          worktreeId: identity.worktreeId,
          file: identity.file,
          extensionId: identity.extensionId,
        })
        .catch(() => {});
    };
  }, [ready, tabIdentity]);
  const registeredDirtyRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (!ready) {
      registeredDirtyRef.current = null;
      return;
    }
    // The first run is covered by the keepalive effect's immediate register.
    const first = registeredDirtyRef.current === null;
    registeredDirtyRef.current = dirty;
    if (first) return;
    void trpc.editors.register.mutate({ ...tabIdentity(), dirty }).catch(() => {});
  }, [ready, dirty, tabIdentity]);
  useEffect(() => {
    if (!ready) return;
    return adapter.subscribeStatusEvents((event) => {
      if (event.kind !== "editor-call" || event.clientId !== getClientId()) return;
      const request = event.editorRequest as
        | {
            callId?: string;
            file?: string;
            extensionId?: string;
            message?: Record<string, unknown>;
          }
        | undefined;
      if (
        !request?.callId ||
        !request.message ||
        event.worktreeId !== worktreeId ||
        request.file !== filePath ||
        request.extensionId !== extensionId ||
        (typeof request.message.id !== "string" && typeof request.message.id !== "number")
      ) {
        return;
      }
      const callId = request.callId;
      const id = request.message.id;
      const answer = (message: Record<string, unknown>) =>
        void trpc.editors.result
          .mutate({ clientId: getClientId(), callId, message })
          .catch(() => {});
      mcp({ ...request.message, id }).then(
        (reply) => answer(reply as Record<string, unknown>),
        (err) =>
          answer({
            jsonrpc: "2.0",
            id,
            error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
          }),
      );
    });
  }, [ready, adapter, worktreeId, filePath, extensionId, mcp]);

  // Another window saved, or something else changed the file: the file watch reports its folder.
  useEffect(() => {
    if (!adapter.subscribeFileChanges) return;
    const watchedDir = parentDirOf(filePath);
    return adapter.subscribeFileChanges(worktreeId, (changedDir) => {
      if (changedDir === watchedDir) void checkDisk();
    });
  }, [adapter, worktreeId, filePath, checkDisk]);

  // A tab shown again may have missed events while it was hidden.
  useEffect(() => {
    if (visible && ready) void checkDisk();
  }, [visible, ready, checkDisk]);

  // Follow Band's theme.
  useEffect(() => {
    if (!ready) return;
    const send = () => post({ type: "theme", ...readTheme() });
    const observer = new MutationObserver(send);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme"],
    });
    return () => observer.disconnect();
  }, [ready, post]);

  // "Close Without Saving" drops the edits.
  useEffect(() => {
    const handler = (e: Event) => {
      if ((e as CustomEvent).detail?.filePath === filePath) {
        markDirty(false);
        setConflict(null);
      }
    };
    window.addEventListener("band:discard-edits", handler);
    return () => window.removeEventListener("band:discard-edits", handler);
  }, [filePath, markDirty]);

  // Cmd+S with focus on the tab (outside the frame) asks the editor to save.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        post({ type: "requestSave" });
      }
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, [post]);

  useEffect(
    () => () => {
      portRef.current?.close();
      portRef.current = null;
      for (const entry of pendingMcp.current.values()) {
        window.clearTimeout(entry.timer);
        entry.reject(new Error("The editor tab was closed"));
      }
      pendingMcp.current.clear();
      setExtensionDirty(worktreeId, filePath, false);
    },
    [worktreeId, filePath],
  );

  const loadTheirs = () => {
    if (!conflict) return;
    knownRef.current = conflict.slice();
    const copy = conflict.slice().buffer;
    post({ type: "reload", bytes: copy }, [copy]);
    markDirty(false);
    setConflict(null);
  };

  const keepMine = () => {
    if (conflict) knownRef.current = conflict.slice();
    setConflict(null);
  };

  const src = hubUrl(`/ext/${encodeURIComponent(extensionId)}/${editor.entry}`);
  const shownError = error ?? saveError;

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      data-band-leaf-root=""
      data-testid="extension-editor"
      data-file-path={filePath}
      data-extension-id={extensionId}
      data-editor-id={editor.id}
      data-ready={ready ? "true" : "false"}
      data-layout={layout}
      className="relative flex h-full w-full flex-col overflow-hidden outline-none"
    >
      {conflict && (
        <div
          className="flex shrink-0 items-center gap-2 border-b border-border bg-muted px-3 py-1.5 text-xs"
          data-testid="center-file-leaf__remote-edit"
        >
          <span className="min-w-0 flex-1">This file changed while you have unsaved edits.</span>
          <Button
            size="sm"
            variant="outline"
            data-testid="center-file-leaf__remote-edit-load"
            onClick={loadTheirs}
          >
            Load theirs
          </Button>
          <Button
            size="sm"
            variant="ghost"
            data-testid="center-file-leaf__remote-edit-keep"
            onClick={keepMine}
          >
            Keep mine
          </Button>
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        <iframe
          ref={frameRef}
          src={src}
          title={editor.label}
          // Scripts only. Never `allow-same-origin`: the frame must not reach Band's cookies, storage or DOM.
          sandbox="allow-scripts"
          onLoad={() => void handshake()}
          className="absolute inset-0 size-full border-0 bg-background"
          data-testid="extension-editor__frame"
        />
        {!ready && !shownError && (
          <div className="pointer-events-none absolute right-2 top-2 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" aria-label="Loading editor" />
          </div>
        )}
        {shownError && (
          <div className="absolute right-2 top-2">
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  aria-label={error ? "Editor failed to load" : "Save failed"}
                  data-testid="extension-editor__error"
                  className="rounded-sm text-destructive"
                >
                  <CircleAlert className="size-4" aria-hidden="true" />
                </button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-72 break-words text-xs text-destructive">
                {shownError}
              </PopoverContent>
            </Popover>
          </div>
        )}
      </div>
      {layout === "compact" && (
        <div className="flex shrink-0 items-center gap-2 border-t border-border bg-background px-3 py-1.5">
          <span
            className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
            data-testid="extension-editor__dirty"
            data-dirty={dirty ? "true" : "false"}
          >
            {fileName(filePath)}
            {dirty ? " · unsaved changes" : ""}
          </span>
          <Button
            size="sm"
            variant={dirty ? "default" : "outline"}
            disabled={!ready || !dirty}
            data-testid="extension-editor__save"
            onClick={() => post({ type: "requestSave" })}
          >
            <Save className="size-3.5" aria-hidden="true" />
            Save
          </Button>
        </div>
      )}
    </div>
  );
});
