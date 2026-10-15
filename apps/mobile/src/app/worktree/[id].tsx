import { Stack, useLocalSearchParams } from "expo-router";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { ChatView } from "../../components/chat/chat-view";
import { AgentPicker, closeTab, renameTab, TabSwitcher } from "../../components/chat/tab-switcher";
import { WorktreeHeader } from "../../components/chat/worktree-header";
import { StateIcon } from "../../components/state-icon";
import { Body, Centered } from "../../components/ui";
import { type ChatTab, useWorktreeTabs } from "../../lib/chat/use-worktree-tabs";
import { SessionGate, useHubSession } from "../../lib/hub-session";
import { useHosts, useRepos, useStatusFeed } from "../../lib/use-hub-data";
import { findRow, type WorktreeRow } from "../../lib/worktree-list";
import { colors, tints, tones } from "../../theme";

/** A worktree's screen: title pill with the shown chat, the chat, and a sheet of the other tabs. */
export default function WorktreeRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <SessionGate>
      <WorktreeScreen id={id} />
    </SessionGate>
  );
}

function WorktreeScreen({ id }: { id: string }) {
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
      <WorktreeChats worktreeId={id} repo={row.repoTitle} branch={row.branch} pr={row.pr} />
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
}: {
  worktreeId: string;
  repo: string;
  branch: string;
  pr: WorktreeRow["pr"];
}) {
  const tabs = useWorktreeTabs(worktreeId);
  const { select, close, move, rename, create } = tabs;
  const actions = useMemo(
    () => ({ select, close, move, rename, create }),
    [select, close, move, rename, create],
  );
  const [sheet, setSheet] = useState(false);
  const [picker, setPicker] = useState(false);
  const pickerAfterSheet = useRef(false);

  // The tab pager: a horizontal paging scroll view holds the previous tab's name, the chats and
  // the next tab's name, so UIKit does the sideways drag. That keeps the vertical transcript, the
  // horizontal tables and the system's left-edge back swipe working, which a JS touch handler
  // over a scroll view cannot do. Landing on a neighbouring page shows that tab.
  const { width } = useWindowDimensions();
  const pager = useRef<ScrollView>(null);
  const [pageHeight, setPageHeight] = useState(0);
  const shownAt = tabs.tabs.findIndex((t) => t.id === tabs.active);
  const prevTab = shownAt > 0 ? tabs.tabs[shownAt - 1] : undefined;
  const nextTab = shownAt >= 0 ? tabs.tabs[shownAt + 1] : undefined;
  const centerX = prevTab ? width : 0;
  // After a tab change the page list changes, so put the shown tab's page back in view.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new shown tab or page list is the trigger
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
  const showMore = () => {
    const options = ["New chat", "Rename chat", "Close chat", "Cancel"];
    ActionSheetIOS.showActionSheetWithOptions(
      {
        options,
        destructiveButtonIndex: 2,
        cancelButtonIndex: 3,
        disabledButtonIndices: current ? [] : [1, 2],
      },
      (choice) => {
        if (choice === 0) setPicker(true);
        else if (choice === 1 && current) renameTab(current, actions);
        else if (choice === 2 && current) closeTab(actions, current.id);
      },
    );
  };

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
      <WorktreeHeader
        repo={repo}
        branch={branch}
        tabs={tabs.tabs}
        active={tabs.active}
        onOpenTabs={() => setSheet(true)}
        onMore={showMore}
      />
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
              {mounted.map(({ id }) => {
                const shown = id === tabs.active;
                return (
                  <View
                    key={id}
                    style={[StyleSheet.absoluteFill, shown ? local.shown : local.kept]}
                    pointerEvents={shown ? "auto" : "none"}
                    accessibilityElementsHidden={!shown}
                    importantForAccessibility={shown ? "auto" : "no-hide-descendants"}
                  >
                    <ChatView
                      chatId={id}
                      worktreeId={worktreeId}
                      active={shown}
                      chips={shown ? chips : null}
                    />
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
            This worktree has no chat yet. Open the tab sheet to start one.
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
        onDismiss={() => {
          if (!pickerAfterSheet.current) return;
          pickerAfterSheet.current = false;
          setPicker(true);
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
      <Text style={local.neighbourText} numberOfLines={1}>
        {direction === "prev" ? "‹ " : ""}
        {tab.label}
        {direction === "next" ? " ›" : ""}
      </Text>
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
