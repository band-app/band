/**
 * The worktree screen's chat tabs: the shared center tabs (`worktree-tabs.ts`), the hub's chats,
 * each chat's agent state, and the actions the tab strip offers.
 *
 * Other devices' changes arrive through the client-state store, which follows the status stream.
 * As on the web, a change made elsewhere while the screen is open adds and removes tabs and
 * reorders them, but leaves the tab the user is looking at alone; the next open takes the shared
 * active tab.
 */

import { type CenterTabs, centerTabsKey, parseCenterTabs } from "@band-app/client/center-tabs";
import { chatTabLabel } from "@band-app/client/chat-tab-label";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useHubSession } from "../hub-session";
import {
  chatStatuses,
  keepAlive,
  moveChat,
  neighbourOf,
  nextUnread,
  type PhoneTabs,
  phoneTabs,
  type TabState,
  tabState,
  writePhoneTabs,
} from "./worktree-tabs";

/** How long to wait for the worktree's shared tabs before showing the hub's chats anyway. */
const TABS_TIMEOUT_MS = 1500;
/** Chats kept mounted (stream open, scroll position kept), the shown one included. */
const KEEP_ALIVE = 3;

export interface AgentChoice {
  id: string;
  label: string;
  isDefault: boolean;
}

export interface ChatTab {
  id: string;
  label: string;
  state: TabState;
}

function readTabs(raw: string | null): CenterTabs | null {
  if (!raw) return null;
  try {
    return parseCenterTabs(JSON.parse(raw));
  } catch {
    return null;
  }
}

interface SettingsLike {
  codingAgents?: { id: string; label: string }[];
  defaultCodingAgent?: string;
}

export function useWorktreeTabs(worktreeId: string) {
  const { client, clientState, feed } = useHubSession();
  const queryClient = useQueryClient();
  const key = centerTabsKey(worktreeId);

  const chatsKey = useMemo(() => ["chats.list", worktreeId], [worktreeId]);
  const chats = useQuery({
    queryKey: chatsKey,
    queryFn: async () => (await client.chats.list.query({ worktreeId })).chats,
  });
  const settings = useQuery({
    queryKey: ["settings.get"],
    queryFn: async () => (await client.settings.get.query()) as SettingsLike | null,
    staleTime: 60_000,
  });

  // A chat made or removed anywhere (the web, the CLI, another phone) changes the list.
  useEffect(
    () =>
      feed.onEvent((event) => {
        if (event.worktreeId !== worktreeId) return;
        if (event.kind === "chat-created" || event.kind === "chat-removed") {
          void queryClient.invalidateQueries({ queryKey: chatsKey });
        }
      }),
    [feed, queryClient, chatsKey, worktreeId],
  );

  // undefined until hydrated (or the timeout passed), then the shared list or null.
  const [shared, setShared] = useState<CenterTabs | null | undefined>(undefined);
  useEffect(() => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      setShared(readTabs(clientState.getItem(key)));
    };
    const timer = setTimeout(finish, TABS_TIMEOUT_MS);
    void clientState.hydrate(worktreeId).then(finish);
    const unsubscribe = clientState.subscribe((change) => {
      if (change.key === key) setShared(parseCenterTabs(change.value));
    });
    return () => {
      done = true;
      clearTimeout(timer);
      unsubscribe();
    };
  }, [clientState, key, worktreeId]);

  // Chats this phone created whose `chat-created` hasn't refreshed the list yet.
  const [created, setCreated] = useState<string[]>([]);
  useEffect(() => {
    const ids = new Set((chats.data ?? []).map((c) => c.id));
    setCreated((c) => (c.some((id) => ids.has(id)) ? c.filter((id) => !ids.has(id)) : c));
  }, [chats.data]);
  const known = useMemo(() => {
    const ids = (chats.data ?? []).map((c) => c.id);
    return [...ids, ...created.filter((id) => !ids.includes(id))];
  }, [chats.data, created]);

  const ready = chats.data !== undefined && shared !== undefined;
  const view: PhoneTabs = useMemo(() => phoneTabs(shared ?? null, known), [shared, known]);

  // The shown tab: the shared active one on open, then the user's choice.
  const [active, setActive] = useState<string | null>(null);
  const chosen = useRef(false);
  const prevChats = useRef<readonly string[]>([]);
  useEffect(() => {
    if (!ready) return;
    const before = prevChats.current;
    prevChats.current = view.chats;
    if (!chosen.current) {
      chosen.current = true;
      setActive(view.active ?? view.chats[0] ?? null);
      return;
    }
    // The shown tab was closed elsewhere: show its neighbour, as a close here does.
    setActive((current) => {
      if (current && view.chats.includes(current)) return current;
      const neighbour = current ? neighbourOf(before, current) : null;
      return neighbour && view.chats.includes(neighbour) ? neighbour : (view.chats[0] ?? null);
    });
  }, [ready, view]);

  const [recent, setRecent] = useState<string[]>([]);
  useEffect(() => {
    if (active) setRecent((r) => [active, ...r.filter((id) => id !== active)].slice(0, 8));
  }, [active]);
  const mounted = useMemo(
    () => keepAlive(recent, active, (id) => view.chats.includes(id), KEEP_ALIVE),
    [recent, active, view.chats],
  );

  // Only this worktree's entry: an event for another worktree keeps its identity, so it doesn't
  // re-render the tabs.
  const worktreeStatus = useSyncExternalStore(feed.subscribe, () =>
    feed.getSnapshot().state.agents.get(worktreeId),
  );
  const statuses = useMemo(() => chatStatuses(worktreeStatus?.tabStatuses), [worktreeStatus]);
  const [unread, setUnread] = useState<ReadonlySet<string>>(new Set());
  const lastStatuses = useRef(statuses);
  useEffect(() => {
    setUnread((u) => nextUnread(u, lastStatuses.current, statuses, active));
    lastStatuses.current = statuses;
  }, [statuses, active]);

  const agents = useMemo((): AgentChoice[] => {
    const list = settings.data?.codingAgents ?? [];
    const defaultId = settings.data?.defaultCodingAgent ?? list[0]?.id;
    return [...list]
      .sort((a, b) => Number(b.id === defaultId) - Number(a.id === defaultId))
      .map((a) => ({ id: a.id, label: a.label, isDefault: a.id === defaultId }));
  }, [settings.data]);

  const tabs = useMemo((): ChatTab[] => {
    const byId = new Map((chats.data ?? []).map((c) => [c.id, c]));
    const defaultId = settings.data?.defaultCodingAgent ?? settings.data?.codingAgents?.[0]?.id;
    return view.chats.map((id) => {
      const chat = byId.get(id);
      const agentId = chat?.agent ?? defaultId;
      return {
        id,
        label: chatTabLabel({
          name: chat?.name,
          summary: chat?.activeSessionSummary,
          agentLabel: settings.data?.codingAgents?.find((a) => a.id === agentId)?.label,
          agentId,
        }),
        state: tabState(id, statuses, unread),
      };
    });
  }, [view.chats, chats.data, settings.data, statuses, unread]);

  const viewRef = useRef(view);
  viewRef.current = view;
  const write = useCallback(
    (nextChats: readonly string[], nextActive: string | null) => {
      const current = readTabs(clientState.getItem(key));
      const next = writePhoneTabs(current, viewRef.current.chats, nextChats, nextActive);
      clientState.setItem(key, JSON.stringify(next));
      setShared(next);
    },
    [clientState, key],
  );

  const select = useCallback(
    (id: string) => {
      chosen.current = true;
      setActive(id);
      write(viewRef.current.chats, id);
    },
    [write],
  );

  const close = useCallback(
    (id: string) => {
      const chatsNow = viewRef.current.chats;
      const rest = chatsNow.filter((c) => c !== id);
      const nextActive = active === id ? neighbourOf(chatsNow, id) : active;
      setActive(nextActive);
      setCreated((c) => c.filter((x) => x !== id));
      // Drop it from the cached list now; until the remove lands it would come back as a chat
      // the shared list lacks. A failed remove refetches it below.
      void queryClient.cancelQueries({ queryKey: chatsKey });
      queryClient.setQueryData(chatsKey, (list: { id: string }[] | undefined) =>
        list?.filter((c) => c.id !== id),
      );
      write(rest, nextActive);
      // Closing a chat tab removes the chat, as the web's close does. A failed remove rejects, so
      // the strip can say so; the refetch shows the chat again.
      return client.chats.remove
        .mutate({ chatId: id })
        .then(() => {})
        .finally(() => queryClient.invalidateQueries({ queryKey: chatsKey }));
    },
    [active, write, client, queryClient, chatsKey],
  );

  const move = useCallback(
    (id: string, delta: number) => {
      write(moveChat(viewRef.current.chats, id, delta), active);
    },
    [write, active],
  );

  const rename = useCallback(
    async (id: string, name: string) => {
      await client.chats.update.mutate({ chatId: id, name: name.trim() || "Chat" });
      await queryClient.invalidateQueries({ queryKey: chatsKey });
    },
    [client, queryClient, chatsKey],
  );

  /** Starts a chat with `agentId` (undefined for the default agent) and shows it. */
  const create = useCallback(
    async (agentId: string | undefined) => {
      const result = await client.agentSessions.launch.mutate({ worktreeId, agentId, mode: "gui" });
      const chatId = result.chatId;
      if (!chatId) throw new Error(result.notice ?? "The hub started no chat.");
      setCreated((c) => (c.includes(chatId) ? c : [...c, chatId]));
      chosen.current = true;
      setActive(chatId);
      const chatsNow = viewRef.current.chats;
      write(chatsNow.includes(chatId) ? chatsNow : [...chatsNow, chatId], chatId);
      void queryClient.invalidateQueries({ queryKey: chatsKey });
    },
    [client, worktreeId, write, queryClient, chatsKey],
  );

  return {
    ready,
    loading: !ready && !chats.isError,
    error: chats.isError,
    tabs,
    active,
    mounted,
    hidden: view.hidden,
    agents,
    select,
    close,
    move,
    rename,
    create,
  };
}
