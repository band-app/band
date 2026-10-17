import { router, Stack, useLocalSearchParams } from "expo-router";
import {
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  GitCompare,
  ListChecks,
  MessageSquarePlus,
  Pencil,
  X,
} from "lucide-react-native";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";

import { AgentIcon } from "../../components/agent-icon";
import { ChatView } from "../../components/chat/chat-view";
import { AgentPicker, closeTab, renameTab, TabSwitcher } from "../../components/chat/tab-switcher";
import { WorktreeHeader } from "../../components/chat/worktree-header";
import { Icon } from "../../components/icon";
import { StateIcon } from "../../components/state-icon";
import { TerminalPane } from "../../components/terminal/terminal-pane";
import { Body, Centered } from "../../components/ui";
import { ViewsSheet, type ViewsSheetItem } from "../../components/views-sheet";
import { type ChatTab, useWorktreeTabs } from "../../lib/chat/use-worktree-tabs";
import { tapDismiss } from "../../lib/composer/tap-dismiss";
import { openChanges, openExplorer } from "../../lib/files/open";
import { SessionGate, useHubSession } from "../../lib/hub-session";
import { useHosts, useRepos, useStatusFeed } from "../../lib/use-hub-data";
import { findRow, type WorktreeRow } from "../../lib/worktree-list";
import { colors, tints, tones } from "../../theme";

/** A worktree's screen: title pill with the shown chat, the chat, and a sheet of the other tabs. */
export default function WorktreeRoute() {
  const { id, openChat } = useLocalSearchParams<{ id: string; openChat?: string }>();
  return (
    <SessionGate>
      <WorktreeScreen id={id} openChat={openChat} />
    </SessionGate>
  );
}

function WorktreeScreen({ id, openChat }: { id: string; openChat?: string }) {
  const { client } = useHubSession();
  const repos = useRepos();
  const hosts = useHosts();
  const { state: statuses } = useStatusFeed();

  // Opening a worktree acknowledges it, as the web dashboard does (`openWorktree`).
  useEffect(() => {
    void client.statuses.clearNeedsAttention.mutate({ worktreeId: id }).catch(() => {});
  }, [client, id]);

  const row = findRow(repos.data ?? [], id, statuses, hosts.data ?? []);
  if (!row) {
    return (
      <Centered>
        <Stack.Screen options={{ headerShown: true, title: "Worktree" }} />
        <Body testID="worktree__missing">
          {repos.isPending ? "Loading…" : "This worktree no longer exists."}
        </Body>
      </Centered>
    );
  }

  return (
    <View style={local.screen} testID="worktree__screen">
      <WorktreeChats
        worktreeId={id}
        repo={row.repoTitle}
        branch={row.branch}
        pr={row.pr}
        openChat={openChat}
      />
    </View>
  );
}

/**
 * The worktree's header, chat tabs and the shown chat. Memoized: the screen re-renders on every
 * hub status event, and this part follows only this worktree's status. The last few chats shown
 * stay mounted under the shown one, so switching back to one shows it at once, at the place the
 * user left it, with its stream still open.
 */
const WorktreeChats = memo(function WorktreeChats({
  worktreeId,
  repo,
  branch,
  pr,
  openChat,
}: {
  worktreeId: string;
  repo: string;
  branch: string;
  pr: WorktreeRow["pr"];
  /** A chat another screen started (the Fix agent); it becomes the shown tab once listed. */
  openChat?: string;
}) {
  const tabs = useWorktreeTabs(worktreeId);
  const { select, close, move, rename, create, createTerminal } = tabs;
  const actions = useMemo(
    () => ({ select, close, move, rename, create, createTerminal }),
    [select, close, move, rename, create, createTerminal],
  );
  const [sheet, setSheet] = useState(false);
  const [picker, setPicker] = useState(false);
  const pickerAfterSheet = useRef(false);
  const [views, setViews] = useState(false);
  // What the Views sheet chose; it runs once the sheet has closed, so a modal never opens over it.
  const afterViews = useRef<(() => void) | null>(null);

  // A chat started elsewhere (the Fix agent) is shown as soon as the tab list has it.
  const shownOpenChat = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!openChat || shownOpenChat.current === openChat) return;
    if (!tabs.tabs.some((t) => t.id === openChat)) return;
    shownOpenChat.current = openChat;
    select(openChat);
  }, [openChat, tabs.tabs, select]);

  // The tab pager: a horizontal paging scroll view holds the previous tab's name, the chats and
  // the next tab's name, so UIKit does the sideways drag. That keeps the vertical transcript, the
  // horizontal tables and the system's left-edge back swipe working, which a JS touch handler
  // over a scroll view cannot do. Landing on a neighbouring page shows that tab.
  const { width } = useWindowDimensions();
  const pager = useRef<ScrollView>(null);
  const dismissOnTap = useMemo(tapDismiss, []);
  const [pageHeight, setPageHeight] = useState(0);
  const shownAt = tabs.tabs.findIndex((t) => t.id === tabs.active);
  const prevTab = shownAt > 0 ? tabs.tabs[shownAt - 1] : undefined;
  const nextTab = shownAt >= 0 ? tabs.tabs[shownAt + 1] : undefined;
  const centerX = prevTab ? width : 0;
  // After a tab change the page list changes, so put the shown tab's page back in view.
  // oxlint-disable-next-line react/exhaustive-deps -- a new shown tab or page list is the trigger
  useLayoutEffect(() => {
    pager.current?.scrollTo({ x: centerX, animated: false });
  }, [tabs.active, centerX, width]);

  if (!tabs.ready) {
    return (
      <Centered>
        {tabs.loading ? (
          <ActivityIndicator color={colors.mutedForeground} />
        ) : (
          <Body testID="worktree__no-chat">Couldn't load this worktree's chats.</Body>
        )}
      </Centered>
    );
  }

  const current = tabs.tabs.find((t) => t.id === tabs.active);
  const afterSheet = (run: () => void) => () => {
    afterViews.current = run;
    setViews(false);
  };
  const viewItems: ViewsSheetItem[] = [
    {
      key: "checks",
      title: "Checks",
      icon: ListChecks,
      subtitle: pr ? `PR #${pr.number}` : undefined,
      onPress: afterSheet(() =>
        router.push({ pathname: "/worktree/[id]/checks", params: { id: worktreeId, branch } }),
      ),
    },
    {
      key: "explorer",
      title: "Explorer",
      icon: FolderOpen,
      onPress: afterSheet(() => openExplorer(worktreeId)),
    },
    {
      key: "changes",
      title: "Changes",
      icon: GitCompare,
      onPress: afterSheet(() => openChanges(worktreeId)),
    },
  ];
  const actionItems: ViewsSheetItem[] = [
    {
      key: "new-chat",
      title: "New chat",
      icon: MessageSquarePlus,
      onPress: afterSheet(() => setPicker(true)),
    },
    {
      key: "rename-chat",
      title: "Rename chat",
      icon: Pencil,
      disabled: !current || current.kind === "term",
      onPress: afterSheet(() => current && renameTab(current, actions)),
    },
    {
      key: "close-tab",
      title: "Close tab",
      icon: X,
      destructive: true,
      disabled: !current,
      onPress: afterSheet(() => current && closeTab(actions, current.id)),
    },
  ];

  const needsYou = tabs.tabs.find((t) => t.id !== tabs.active && t.shown === "question");
  const chips =
    needsYou || pr ? (
      <View style={local.chips} testID="worktree__chips">
        {needsYou ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${needsYou.label}: question`}
            onPress={() => select(needsYou.id)}
            style={[local.chip, local.chipAsk]}
            testID="worktree__chip-question"
          >
            <StateIcon state="question" />
            {needsYou.kind === "chat" ? <AgentIcon type={needsYou.agentType} size={14} /> : null}
            <Text style={local.chipText} numberOfLines={1}>
              {needsYou.label}: question
            </Text>
          </Pressable>
        ) : null}
        {pr ? (
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={`Pull request ${pr.number}`}
            onPress={() => {
              if (pr.url.startsWith("https://")) void Linking.openURL(pr.url).catch(() => {});
            }}
            style={local.chip}
            testID="worktree__chip-pr"
          >
            <Text style={local.chipText}>PR #{pr.number}</Text>
          </Pressable>
        ) : null}
      </View>
    ) : null;

  // Stable order, so a change of the shown tab never moves a mounted chat's view.
  const mounted = tabs.tabs.filter((t) => tabs.mounted.includes(t.id));
  return (
    <View style={local.fill}>
      <View {...dismissOnTap}>
        <WorktreeHeader
          repo={repo}
          branch={branch}
          tabs={tabs.tabs}
          active={tabs.active}
          onOpenTabs={() => setSheet(true)}
          onMore={() => setViews(true)}
        />
      </View>
      {tabs.active ? (
        <View style={local.chats}>
          <ScrollView
            ref={pager}
            horizontal
            pagingEnabled
            keyboardShouldPersistTaps="handled"
            bounces={false}
            showsHorizontalScrollIndicator={false}
            contentOffset={{ x: centerX, y: 0 }}
            onLayout={(e) => setPageHeight(e.nativeEvent.layout.height)}
            onMomentumScrollEnd={(e) => {
              const page = Math.round(e.nativeEvent.contentOffset.x / width);
              const target = [prevTab, current, nextTab].filter(Boolean)[page];
              if (target && target.id !== tabs.active) select(target.id);
              else pager.current?.scrollTo({ x: centerX, animated: false });
            }}
            style={local.pager}
            testID="worktree__pager"
          >
            {prevTab ? (
              <NeighbourPage tab={prevTab} direction="prev" width={width} height={pageHeight} />
            ) : null}
            <View style={{ width, height: pageHeight }}>
              {mounted.map(({ id, kind }) => {
                const shown = id === tabs.active;
                return (
                  <View
                    key={id}
                    style={[StyleSheet.absoluteFill, shown ? local.shown : local.kept]}
                    pointerEvents={shown ? "auto" : "none"}
                    accessibilityElementsHidden={!shown}
                    importantForAccessibility={shown ? "auto" : "no-hide-descendants"}
                  >
                    {kind === "term" ? (
                      <TerminalPane terminalId={id} worktreeId={worktreeId} active={shown} />
                    ) : (
                      <ChatView
                        chatId={id}
                        worktreeId={worktreeId}
                        active={shown}
                        chips={shown ? chips : null}
                      />
                    )}
                  </View>
                );
              })}
            </View>
            {nextTab ? (
              <NeighbourPage tab={nextTab} direction="next" width={width} height={pageHeight} />
            ) : null}
          </ScrollView>
          {/* The pager would take a drag from the left edge as a tab swipe. This strip takes the
            touch first, so the system's back swipe gets it instead. */}
          <View style={local.edge} collapsable={false} pointerEvents="auto" />
        </View>
      ) : (
        <Centered>
          <Body testID="worktree__no-chat">
            This worktree has no tab yet. Open the tab sheet to start a chat or a terminal.
          </Body>
        </Centered>
      )}
      <TabSwitcher
        visible={sheet}
        onClose={() => setSheet(false)}
        title={`${repo} · ${branch}`}
        tabs={tabs.tabs}
        active={tabs.active}
        hidden={tabs.hidden}
        actions={actions}
        onNew={() => {
          pickerAfterSheet.current = true;
          setSheet(false);
        }}
        onNewTerminal={() => {
          setSheet(false);
          actions.createTerminal().catch(() => Alert.alert("Couldn't open a terminal"));
        }}
        onDismiss={() => {
          if (!pickerAfterSheet.current) return;
          pickerAfterSheet.current = false;
          setPicker(true);
        }}
      />
      <ViewsSheet
        visible={views}
        onClose={() => setViews(false)}
        title={`${repo} · ${branch}`}
        views={viewItems}
        actions={actionItems}
        onDismiss={() => {
          const run = afterViews.current;
          afterViews.current = null;
          run?.();
        }}
      />
      <AgentPicker
        visible={picker}
        onClose={() => setPicker(false)}
        agents={tabs.agents}
        onPick={actions.create}
      />
    </View>
  );
});

/** What a swipe reveals before the neighbouring tab takes over: its name and state. */
function NeighbourPage({
  tab,
  direction,
  width,
  height,
}: {
  tab: ChatTab;
  direction: "prev" | "next";
  width: number;
  height: number;
}) {
  return (
    <View style={[local.neighbour, { width, height }]} testID={`worktree__neighbour-${direction}`}>
      <StateIcon state={tab.shown} />
      {direction === "prev" ? <Icon icon={ChevronLeft} color={colors.mutedForeground} /> : null}
      {tab.kind === "chat" ? (
        <AgentIcon type={tab.agentType} size={16} color={colors.mutedForeground} />
      ) : null}
      <Text style={local.neighbourText} numberOfLines={1}>
        {tab.label}
      </Text>
      {direction === "next" ? <Icon icon={ChevronRight} color={colors.mutedForeground} /> : null}
    </View>
  );
}

const local = StyleSheet.create({
  edge: { bottom: 0, left: 0, position: "absolute", top: 0, width: 18 },
  neighbour: { alignItems: "center", flexDirection: "row", gap: 8, justifyContent: "center" },
  neighbourText: { color: colors.mutedForeground, fontSize: 16 },
  screen: { backgroundColor: colors.background, flex: 1 },
  fill: { flex: 1 },
  chats: { flex: 1 },
  pager: { flex: 1 },
  shown: { opacity: 1, zIndex: 1 },
  kept: { opacity: 0, zIndex: 0 },
  chips: { flexDirection: "row", gap: 8, paddingHorizontal: 12, paddingTop: 6 },
  chip: {
    alignItems: "center",
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderRadius: 19,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    flexShrink: 1,
    gap: 7,
    height: 38,
    paddingHorizontal: 14,
  },
  chipAsk: { backgroundColor: tints.pending, borderColor: tones.attention },
  chipText: { color: colors.foreground, flexShrink: 1, fontSize: 14 },
});
