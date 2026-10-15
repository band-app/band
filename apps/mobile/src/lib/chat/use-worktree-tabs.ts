/**
 * The worktree screen's chat and terminal tabs: the shared center tabs (`worktree-tabs.ts`), the hub's chats,
 * each chat's agent state, and the actions the tab strip offers.
 *
 * Other devices' changes arrive through the client-state store, which follows the status stream.
 * As on the web, a change made elsewhere while the screen is open adds and removes tabs and
 * reorders them, but leaves the tab the user is looking at alone; the next open takes the shared
 * active tab.
 */

import {
  type CenterTab,
  type CenterTabs,
  centerTabsKey,
  parseCenterTabs,
} from "@band-app/client/center-tabs";
import { chatTabLabel } from "@band-app/client/chat-tab-label";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useHubSession } from "../hub-session";
import { ageLabel, type ShownState, shownState } from "../status-state";
import { getPending, pendingVersion, subscribePending } from "./pending-store";
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
  /** A chat, or a terminal (whose state is always idle). */
  kind: "chat" | "term";
  label: string;
  state: TabState;
  /** The icon: the hub's status mapped by `shownState`. */
  shown: ShownState;
  /** One line under the name: the question while one waits, else the last activity. */
  summary: string;
}

/** What the sheet says under a tab's name. */
function summaryOf(
  shown: ShownState,
  pendingText: string | undefined,
  chat: { activeSessionSummary?: string; activeSessionLastModified?: number } | undefined,
  now: number,
): string {
  const age = ageLabel(chat?.activeSessionLastModified, now);
  switch (shown) {
    case "question":
      return pendingText ? `Asks: ${pendingText}` : "Waiting for you";
    case "working":
      return age ? `Working · ${age}` : "Working";
    case "done":
      return age ? `Finished · ${age}` : "Finished";
    case "failed":
      return age ? `Failed · ${age}` : "Failed";
    case "monitoring":
      return "Monitoring";
    default:
      return chat?.activeSessionSummary || (age ? `Last activity ${age} ago` : "No messages yet");
  }
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
  const terminalsKey = useMemo(() => ["terminal.list", worktreeId], [worktreeId]);
  const terminals = useQuery({
    queryKey: terminalsKey,
    queryFn: async () => (await client.terminal.list.query({ worktreeId })).terminals,
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
        if (event.kind === "terminal-created" || event.kind === "terminal-killed") {
          void queryClient.invalidateQueries({ queryKey: terminalsKey });
        }
      }),
    [feed, queryClient, chatsKey, terminalsKey, worktreeId],
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

  // Terminals this phone opened whose `terminal-created` hasn't refreshed the list yet.
  const [createdTerms, setCreatedTerms] = useState<string[]>([]);
  useEffect(() => {
    const ids = new Set((terminals.data ?? []).map((t) => t.terminalId));
    setCreatedTerms((c) => (c.some((id) => ids.has(id)) ? c.filter((id) => !ids.has(id)) : c));
  }, [terminals.data]);
  const knownTerms = useMemo(() => {
    const ids = (terminals.data ?? []).map((t) => t.terminalId);
    return [...ids, ...createdTerms.filter((id) => !ids.includes(id))];
  }, [terminals.data, createdTerms]);

  // A failed terminal list shows the chats alone rather than hiding the worktree.
  const ready = chats.data !== undefined && shared !== undefined && !terminals.isPending;
  const view: PhoneTabs = useMemo(
    () => phoneTabs(shared ?? null, known, knownTerms),
    [shared, known, knownTerms],
  );

  // The shown tab: the shared active one on open, then the user's choice.
  const [active, setActive] = useState<string | null>(null);
  const chosen = useRef(false);
  const prevChats = useRef<readonly string[]>([]);
  useEffect(() => {
    if (!ready) return;
    const before = prevChats.current;
    prevChats.current = view.ids;
    if (!chosen.current) {
      chosen.current = true;
      setActive(view.active ?? view.ids[0] ?? null);
      return;
    }
    // The shown tab was closed elsewhere: show its neighbour, as a close here does.
    setActive((current) => {
      if (current && view.ids.includes(current)) return current;
      const neighbour = current ? neighbourOf(before, current) : null;
      return neighbour && view.ids.includes(neighbour) ? neighbour : (view.ids[0] ?? null);
    });
  }, [ready, view]);

  const [recent, setRecent] = useState<string[]>([]);
  useEffect(() => {
    if (active) setRecent((r) => [active, ...r.filter((id) => id !== active)].slice(0, 8));
  }, [active]);
  const mounted = useMemo(
    () => keepAlive(recent, active, (id) => view.ids.includes(id), KEEP_ALIVE),
    [recent, active, view.ids],
  );

  // Only this worktree's entry: an event for another worktree keeps its identity, so it doesn't
  // re-render the tabs.
  const worktreeStatus = useSyncExternalStore(feed.subscribe, () =>
    feed.getSnapshot().state.agents.get(worktreeId),
  );
  const statuses = useMemo(() => chatStatuses(worktreeStatus?.tabStatuses), [worktreeStatus]);
  // The hub's chat status says whether a turn is still open, which tells a question from a
  // finished turn; it changes with the worktree's status, so read it again then.
  const refetchChats = chats.refetch;
  const statusKey = useMemo(
    () => JSON.stringify(worktreeStatus?.tabStatuses ?? []),
    [worktreeStatus],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new status is the trigger
  useEffect(() => {
    void refetchChats();
  }, [statusKey, refetchChats]);
  const pendingTick = useSyncExternalStore(subscribePending, pendingVersion);
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: pendingTick re-reads the pending store
  const tabs = useMemo((): ChatTab[] => {
    const byId = new Map((chats.data ?? []).map((c) => [c.id, c]));
    const defaultId = settings.data?.defaultCodingAgent ?? settings.data?.codingAgents?.[0]?.id;
    const termById = new Map((terminals.data ?? []).map((t) => [t.terminalId, t]));
    let termNumber = 0;
    return view.tabs.map(({ id, kind }): ChatTab => {
      if (kind === "term") {
        termNumber += 1;
        const title = termById.get(id)?.title;
        return {
          id,
          kind,
          label: `Terminal ${termNumber}`,
          state: "idle",
          shown: "idle",
          summary: title ? `Running ${title}` : "Shell",
        };
      }
      const chat = byId.get(id);
      const agentId = chat?.agent ?? defaultId;
      const hubStatus = statuses.get(id);
      const pendingText = getPending(id);
      const hubShown = shownState({
        status: hubStatus,
        pending: pendingText !== undefined || chat?.status === "running",
        failed: chat?.status === "error",
      });
      const shown: ShownState = hubShown === "idle" && unread.has(id) ? "done" : hubShown;
      return {
        id,
        kind: "chat",
        label: chatTabLabel({
          name: chat?.name,
          summary: chat?.activeSessionSummary,
          agentLabel: settings.data?.codingAgents?.find((a) => a.id === agentId)?.label,
          agentId,
        }),
        state: tabState(id, statuses, unread),
        shown,
        summary: summaryOf(shown, pendingText, chat, Date.now()),
      };
    });
  }, [view.tabs, chats.data, terminals.data, settings.data, statuses, unread, pendingTick]);

  const viewRef = useRef(view);
  viewRef.current = view;
  const write = useCallback(
    (nextTabs: readonly CenterTab[], nextActive: string | null) => {
      const current = readTabs(clientState.getItem(key));
      const next = writePhoneTabs(current, viewRef.current.ids, nextTabs, nextActive);
      clientState.setItem(key, JSON.stringify(next));
      setShared(next);
    },
    [clientState, key],
  );

  const select = useCallback(
    (id: string) => {
      chosen.current = true;
      setActive(id);
      write(viewRef.current.tabs, id);
    },
    [write],
  );

  const close = useCallback(
    (id: string) => {
      const tabsNow = viewRef.current.tabs;
      const kind = tabsNow.find((t) => t.id === id)?.kind ?? "chat";
      const rest = tabsNow.filter((t) => t.id !== id);
      const nextActive =
        active === id
          ? neighbourOf(
              tabsNow.map((t) => t.id),
              id,
            )
          : active;
      setActive(nextActive);
      write(rest, nextActive);
      if (kind === "term") {
        setCreatedTerms((c) => c.filter((x) => x !== id));
        void queryClient.cancelQueries({ queryKey: terminalsKey });
        queryClient.setQueryData(terminalsKey, (list: { terminalId: string }[] | undefined) =>
          list?.filter((t) => t.terminalId !== id),
        );
        // Closing a terminal tab kills its shell, as the web's close does.
        return client.terminal.kill
          .mutate({ terminalId: id })
          .then(() => {})
          .finally(() => queryClient.invalidateQueries({ queryKey: terminalsKey }));
      }
      setCreated((c) => c.filter((x) => x !== id));
      // Drop it from the cached list now; until the remove lands it would come back as a chat
      // the shared list lacks. A failed remove refetches it below.
      void queryClient.cancelQueries({ queryKey: chatsKey });
      queryClient.setQueryData(chatsKey, (list: { id: string }[] | undefined) =>
        list?.filter((c) => c.id !== id),
      );
      // Closing a chat tab removes the chat, as the web's close does. A failed remove rejects, so
      // the strip can say so; the refetch shows the chat again.
      return client.chats.remove
        .mutate({ chatId: id })
        .then(() => {})
        .finally(() => queryClient.invalidateQueries({ queryKey: chatsKey }));
    },
    [active, write, client, queryClient, chatsKey, terminalsKey],
  );

  const move = useCallback(
    (id: string, delta: number) => {
      const tabsNow = viewRef.current.tabs;
      const order = moveChat(
        tabsNow.map((t) => t.id),
        id,
        delta,
      );
      const byId = new Map(tabsNow.map((t) => [t.id, t]));
      write(
        order.flatMap((x) => byId.get(x) ?? []),
        active,
      );
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
      const tabsNow = viewRef.current.tabs;
      write(
        tabsNow.some((t) => t.id === chatId)
          ? tabsNow
          : [...tabsNow, { id: chatId, kind: "chat" as const }],
        chatId,
      );
      void queryClient.invalidateQueries({ queryKey: chatsKey });
    },
    [client, worktreeId, write, queryClient, chatsKey],
  );

  /** Opens a shell in this worktree and shows it. */
  const createTerminal = useCallback(async () => {
    const { terminalId } = await client.terminal.create.mutate({ worktreeId });
    setCreatedTerms((c) => (c.includes(terminalId) ? c : [...c, terminalId]));
    chosen.current = true;
    setActive(terminalId);
    const tabsNow = viewRef.current.tabs;
    write(
      tabsNow.some((t) => t.id === terminalId)
        ? tabsNow
        : [...tabsNow, { id: terminalId, kind: "term" as const }],
      terminalId,
    );
    void queryClient.invalidateQueries({ queryKey: terminalsKey });
  }, [client, worktreeId, write, queryClient, terminalsKey]);

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
    createTerminal,
  };
}
