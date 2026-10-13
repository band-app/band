import { Stack, useLocalSearchParams } from "expo-router";
import { memo, useEffect, useMemo } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ChatView } from "../../components/chat/chat-view";
import { TabStrip } from "../../components/chat/tab-strip";
import { Body, Centered } from "../../components/ui";
import { StatePill } from "../../components/worktree-row";
import { useWorktreeTabs } from "../../lib/chat/use-worktree-tabs";
import { SessionGate, useHubSession } from "../../lib/hub-session";
import { useHosts, useRepos, useStatusFeed } from "../../lib/use-hub-data";
import { findRow } from "../../lib/worktree-list";
import { colors } from "../../theme";

/** A worktree's screen: a line naming its branch and host, its chat tabs, then the shown chat. */
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
        <Stack.Screen options={{ title: "Worktree" }} />
        <Body testID="worktree__missing">
          {repos.isPending ? "Loading…" : "This worktree no longer exists."}
        </Body>
      </Centered>
    );
  }

  return (
    <SafeAreaView style={local.screen} edges={["left", "right"]} testID="worktree__screen">
      <Stack.Screen options={{ title: row.name }} />
      <View style={local.bar}>
        <View style={local.names}>
          <Text style={local.name} numberOfLines={1} testID="worktree__name">
            {row.name}
          </Text>
          <View style={local.meta}>
            <Text style={local.line} numberOfLines={1} testID="worktree__branch">
              {row.branch}
            </Text>
            <Text style={local.line}>·</Text>
            <Text style={local.line} numberOfLines={1} testID="worktree__host">
              {row.hostTag}
            </Text>
          </View>
        </View>
        <StatePill row={row} />
      </View>
      <WorktreeChats worktreeId={id} />
    </SafeAreaView>
  );
}

/**
 * The worktree's chat tabs and the shown chat. Memoized: the screen re-renders on every hub status
 * event. The last few chats shown stay mounted under the shown one, so switching back to one shows
 * it at once, at the place the user left it, with its stream still open.
 */
const WorktreeChats = memo(function WorktreeChats({ worktreeId }: { worktreeId: string }) {
  const tabs = useWorktreeTabs(worktreeId);
  const { select, close, move, rename, create } = tabs;
  const actions = useMemo(
    () => ({ select, close, move, rename, create }),
    [select, close, move, rename, create],
  );
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
  // Stable order, so a change of the shown tab never moves a mounted chat's view.
  const mounted = tabs.tabs.filter((t) => tabs.mounted.includes(t.id));
  return (
    <>
      <TabStrip
        tabs={tabs.tabs}
        active={tabs.active}
        hidden={tabs.hidden}
        agents={tabs.agents}
        actions={actions}
      />
      {tabs.active ? (
        <View style={local.chats}>
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
                <ChatView chatId={id} worktreeId={worktreeId} active={shown} />
              </View>
            );
          })}
        </View>
      ) : (
        <Centered>
          <Body testID="worktree__no-chat">This worktree has no chat yet. Tap + to start one.</Body>
        </Centered>
      )}
    </>
  );
});

const local = StyleSheet.create({
  screen: { backgroundColor: colors.background, flex: 1 },
  bar: {
    alignItems: "center",
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  names: { flex: 1, gap: 2 },
  name: { color: colors.foreground, fontSize: 15, fontWeight: "600" },
  meta: { flexDirection: "row", gap: 6 },
  line: { color: colors.mutedForeground, flexShrink: 1, fontSize: 13 },
  chats: { flex: 1 },
  shown: { opacity: 1, zIndex: 1 },
  kept: { opacity: 0, zIndex: 0 },
});
