import { Stack, useLocalSearchParams } from "expo-router";
import { useEffect } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Body, Centered, Screen, Title, styles as ui } from "../../components/ui";
import { StatePill } from "../../components/worktree-row";
import { SessionGate, useHubSession } from "../../lib/hub-session";
import { useHosts, useRepos, useStatusFeed } from "../../lib/use-hub-data";
import { findRow } from "../../lib/worktree-list";
import { colors } from "../../theme";

/** A worktree's screen. The header names it; M1.4 fills the body with its chats. */
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
    <Screen testID="worktree__screen">
      <Stack.Screen options={{ title: row.name }} />
      <View style={ui.card}>
        <Title testID="worktree__name">{row.name}</Title>
        <Text style={local.line} testID="worktree__branch">
          {row.branch}
        </Text>
        <Text style={local.line} testID="worktree__host">
          {row.hostTag}
        </Text>
        <Text style={local.line}>{row.repo}</Text>
        <View style={local.pill}>
          <StatePill row={row} />
        </View>
      </View>
      <Body>Chats for this worktree arrive in the next step.</Body>
    </Screen>
  );
}

const local = StyleSheet.create({
  line: { color: colors.foreground, fontSize: 15 },
  pill: { flexDirection: "row", marginTop: 6 },
});
