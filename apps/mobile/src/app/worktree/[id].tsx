import { Stack, useLocalSearchParams } from "expo-router";
import { memo, useEffect } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { ChatView } from "../../components/chat/chat-view";
import { Body, Centered } from "../../components/ui";
import { StatePill } from "../../components/worktree-row";
import { useActiveChat } from "../../lib/chat/use-active-chat";
import { SessionGate, useHubSession } from "../../lib/hub-session";
import { useHosts, useRepos, useStatusFeed } from "../../lib/use-hub-data";
import { findRow } from "../../lib/worktree-list";
import { colors } from "../../theme";

/** A worktree's screen: a line naming its branch and host, then its active chat. */
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
      <WorktreeChat worktreeId={id} />
    </SafeAreaView>
  );
}

/** Memoized: the screen re-renders on every hub status event, the chat only on its own data. */
const WorktreeChat = memo(function WorktreeChat({ worktreeId }: { worktreeId: string }) {
  const { chatId, loading, error } = useActiveChat(worktreeId);
  if (chatId) return <ChatView key={chatId} chatId={chatId} worktreeId={worktreeId} />;
  return (
    <Centered>
      {loading ? (
        <ActivityIndicator color={colors.mutedForeground} />
      ) : (
        <Body testID="worktree__no-chat">
          {error ? "Couldn't load this worktree's chats." : "This worktree has no chat yet."}
        </Body>
      )}
    </Centered>
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
});
