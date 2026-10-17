/**
 * What the chat's cells share without passing props through every row: the hub (for images),
 * what tapping a file path or copying does, and which collapsibles are open.
 *
 * The list recycles cells, so a cell's own state would follow the cell to another row. Open and
 * closed is kept here instead, keyed by the entry's id.
 */

import * as Clipboard from "expo-clipboard";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { ActionSheetIOS, Alert } from "react-native";

import { messageActions, rowTime, timeAgo } from "../../lib/chat/message-actions";
import { type ChatRow, copyText } from "../../lib/chat/rows";

class OpenSet {
  private readonly open = new Set<string>();
  private readonly listeners = new Map<string, Set<() => void>>();

  isOpen(id: string): boolean {
    return this.open.has(id);
  }

  toggle(id: string): void {
    if (this.open.has(id)) this.open.delete(id);
    else this.open.add(id);
    for (const listener of this.listeners.get(id) ?? []) listener();
  }

  subscribe(id: string, listener: () => void): () => void {
    let set = this.listeners.get(id);
    if (!set) {
      set = new Set();
      this.listeners.set(id, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(id);
    };
  }
}

interface ChatContextValue {
  hubUrl: string;
  token: string;
  openSet: OpenSet;
  onToggle: () => void;
  copy: (text: string) => void;
  /**
   * Opens the action sheet of the row `key` (Copy, and when the message was sent), read from the
   * current transcript.
   */
  showActions: (key: string) => void;
  openFile: (path: string) => void;
}

const ChatContext = createContext<ChatContextValue | null>(null);

export function ChatProvider({
  hubUrl,
  token,
  onCopied,
  onToggle,
  rowFor,
  onOpenFile,
  children,
}: {
  hubUrl: string;
  token: string;
  onCopied: () => void;
  /** Called when the user opens or closes a collapsible. */
  onToggle: () => void;
  /**
   * A row as the transcript holds it now. A memoized row can be stale: an earlier part of a
   * message that is still growing doesn't re-render, but copies the whole message.
   */
  rowFor: (key: string) => ChatRow | undefined;
  /** Opens a file path the chat shows (`src/a.ts` or `src/a.ts:12`). Without it a tap says so. */
  onOpenFile?: (path: string) => void;
  children: ReactNode;
}) {
  const openSet = useRef(new OpenSet()).current;
  const copiedRef = useRef(onCopied);
  copiedRef.current = onCopied;
  const toggledRef = useRef(onToggle);
  toggledRef.current = onToggle;
  const rowForRef = useRef(rowFor);
  rowForRef.current = rowFor;
  const openFileRef = useRef(onOpenFile);
  openFileRef.current = onOpenFile;
  const value = useMemo<ChatContextValue>(() => {
    const copy = (text: string) => {
      if (!text) return;
      Clipboard.setStringAsync(text).then(
        () => copiedRef.current(),
        () => Alert.alert("Couldn't copy"),
      );
    };
    return {
      hubUrl,
      token,
      openSet,
      onToggle: () => toggledRef.current(),
      copy,
      showActions: (key) => {
        const row = rowForRef.current(key);
        if (!row) return;
        const actions = messageActions(row);
        const sent = rowTime(row);
        if (actions.length === 0 && sent === undefined) return;
        const text = copyText(row);
        ActionSheetIOS.showActionSheetWithOptions(
          {
            title: sent === undefined ? undefined : new Date(sent).toLocaleString(),
            message: sent === undefined ? undefined : timeAgo(sent, Date.now()),
            options: [...actions.map(() => "Copy"), "Cancel"],
            cancelButtonIndex: actions.length,
          },
          (index) => {
            if (actions[index] === "copy") copy(text);
          },
        );
      },
      openFile: (path) => {
        if (openFileRef.current) openFileRef.current(path);
        else Alert.alert(path, "This file can't be opened here.");
      },
    };
  }, [hubUrl, token, openSet]);
  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChat(): ChatContextValue {
  const value = useContext(ChatContext);
  if (!value) throw new Error("useChat needs a ChatProvider");
  return value;
}

/** Whether the collapsible `id` is open, and a toggle for it. */
export function useOpen(id: string): [boolean, () => void] {
  const { openSet, onToggle } = useChat();
  const subscribe = useCallback((cb: () => void) => openSet.subscribe(id, cb), [openSet, id]);
  const open = useSyncExternalStore(subscribe, () => openSet.isOpen(id));
  const toggle = useCallback(() => {
    onToggle();
    openSet.toggle(id);
  }, [openSet, onToggle, id]);
  return [open, toggle];
}

/** The URL and headers of a file the chat shows, for `<Image source>`. */
export function useAssetSource(url: string): { uri: string; headers?: Record<string, string> } {
  const { hubUrl, token } = useChat();
  // no-store keeps iOS's URL cache from writing the request, Authorization header included, to
  // Library/Caches (the reason `hub-session.tsx` sends it on every fetch).
  const auth = { Authorization: `Bearer ${token}`, "Cache-Control": "no-store" };
  // The token goes only to the hub, never to a URL on another origin.
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
    return url.startsWith(`${hubUrl}/`) ? { uri: url, headers: auth } : { uri: url };
  }
  return { uri: `${hubUrl}${url.startsWith("/") ? "" : "/"}${url}`, headers: auth };
}
