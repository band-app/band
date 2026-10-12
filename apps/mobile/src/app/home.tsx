import { Redirect, router, Stack } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Pressable,
  RefreshControl,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Button } from "../components/ui";
import { WorktreeRowView } from "../components/worktree-row";
import { SessionGate, useHubSession } from "../lib/hub-session";
import { useHubs } from "../lib/hubs-context";
import { resetTo } from "../lib/navigation";
import { useCollapsedRepos } from "../lib/use-collapsed-repos";
import { useHosts, useRepos, useStatusFeed } from "../lib/use-hub-data";
import { buildSections, countAttention, type RepoSection } from "../lib/worktree-list";
import { colors, tones } from "../theme";

export default function Home() {
  const { active } = useHubs();
  if (!active) return <Redirect href="/connect" />;
  return (
    <SessionGate>
      <WorktreeList />
    </SessionGate>
  );
}

function WorktreeList() {
  const { active, connection, recheck } = useHubs();
  const { clientStateReady } = useHubSession();
  const repos = useRepos();
  const hosts = useHosts();
  const { state: statuses, connection: stream } = useStatusFeed();
  const { collapsed, toggle } = useCollapsedRepos();
  const [query, setQuery] = useState("");
  const [needsMeOnly, setNeedsMeOnly] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // At start and on return to the foreground, a hub that no longer answers leads to the
  // unreachable screen, where Retry and the hub switcher live.
  useEffect(() => {
    let cancelled = false;
    const check = () =>
      void recheck().then((c) => {
        if (!cancelled && c.state === "unreachable") resetTo("/unreachable");
      });
    check();
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") check();
    });
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, [recheck]);

  const repoList = repos.data;
  const hostList = hosts.data;
  const sections = useMemo(
    () =>
      buildSections(repoList ?? [], {
        statuses,
        hosts: hostList ?? [],
        collapsed,
        query,
        needsMeOnly,
      }),
    [repoList, hostList, statuses, collapsed, query, needsMeOnly],
  );
  const attention = useMemo(() => countAttention(repoList ?? [], statuses), [repoList, statuses]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([repos.refetch(), hosts.refetch()]);
    } finally {
      setRefreshing(false);
    }
  }, [repos, hosts]);

  const loading = repos.isPending || !clientStateReady;
  const filtering = query.trim() !== "" || needsMeOnly;

  return (
    <View style={styles.screen} testID="home__screen">
      <Stack.Screen
        options={{
          headerRight: () => (
            <Pressable
              onPress={() => router.push("/hubs")}
              accessibilityRole="button"
              testID="home__hubs"
            >
              <Text style={styles.headerButton}>Hubs</Text>
            </Pressable>
          ),
        }}
      />
      {stream === "reconnecting" ? (
        <View style={styles.banner} testID="home__reconnecting">
          <ActivityIndicator color={colors.foreground} size="small" />
          <Text style={styles.bannerText}>Reconnecting…</Text>
        </View>
      ) : null}
      <View style={styles.hubBar}>
        <View
          style={[
            styles.dot,
            { backgroundColor: connection.state === "connected" ? colors.success : colors.warning },
          ]}
        />
        <Text style={styles.hubName} numberOfLines={1} testID="home__hub-name">
          {active?.label}
        </Text>
        <Text style={styles.status} testID="home__status">
          {connection.state === "connected" ? "Connected" : "Checking…"}
        </Text>
      </View>
      <Text style={styles.hubUrl} testID="home__hub-url">
        {active?.url}
      </Text>
      <View style={styles.tools}>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search worktrees"
          placeholderTextColor={colors.mutedForeground}
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
          returnKeyType="search"
          style={styles.search}
          accessibilityLabel="Search worktrees"
          testID="home__search"
        />
        <Pressable
          onPress={() => setNeedsMeOnly((on) => !on)}
          accessibilityRole="button"
          accessibilityState={{ selected: needsMeOnly }}
          accessibilityLabel={`Needs me, ${attention}`}
          testID="home__needs-me"
          style={[styles.chip, needsMeOnly && styles.chipOn]}
        >
          <Text style={[styles.chipText, needsMeOnly && styles.chipTextOn]}>
            Needs me{attention > 0 ? ` (${attention})` : ""}
          </Text>
        </Pressable>
      </View>
      <SectionList<RepoSection["data"][number], RepoSection>
        sections={sections}
        keyExtractor={(row) => row.id}
        stickySectionHeadersEnabled={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={refresh}
            tintColor={colors.foreground}
          />
        }
        renderSectionHeader={({ section }) => (
          <RepoHeader
            section={section}
            filtering={filtering}
            onToggle={() => toggle(section.name)}
          />
        )}
        renderItem={({ item }) => (
          <WorktreeRowView
            row={item}
            onPress={() => router.push({ pathname: "/worktree/[id]", params: { id: item.id } })}
          />
        )}
        ListEmptyComponent={
          <Empty
            loading={loading}
            error={repos.isError}
            filtering={filtering}
            onRetry={() => void repos.refetch()}
          />
        }
        contentContainerStyle={styles.list}
        testID="home__list"
      />
    </View>
  );
}

function RepoHeader({
  section,
  filtering,
  onToggle,
}: {
  section: RepoSection;
  filtering: boolean;
  onToggle: () => void;
}) {
  return (
    <Pressable
      onPress={onToggle}
      disabled={filtering}
      accessibilityRole="button"
      accessibilityLabel={`${section.title}, ${section.total} worktrees, ${section.collapsed ? "collapsed" : "expanded"}`}
      accessibilityState={{ expanded: !section.collapsed }}
      testID={`home__repo-${section.name}`}
      style={styles.repoHeader}
    >
      <Text style={styles.chevron}>{section.collapsed ? "▸" : "▾"}</Text>
      <Text style={styles.repoTitle} numberOfLines={1}>
        {section.title}
      </Text>
      <Text style={styles.repoCount}>{section.total}</Text>
      {section.collapsed && section.attention > 0 ? (
        <View style={styles.repoAttention} testID={`home__repo-attention-${section.name}`}>
          <Text style={styles.repoAttentionText}>{section.attention} need you</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

function Empty({
  loading,
  error,
  filtering,
  onRetry,
}: {
  loading: boolean;
  error: boolean;
  filtering: boolean;
  onRetry: () => void;
}) {
  if (loading) {
    return (
      <View style={styles.empty} testID="home__loading">
        <ActivityIndicator color={colors.foreground} />
      </View>
    );
  }
  if (error) {
    return (
      <View style={styles.empty} testID="home__error">
        <Text style={styles.emptyText}>Could not load the repos.</Text>
        <Button label="Retry" onPress={onRetry} variant="secondary" testID="home__retry" />
      </View>
    );
  }
  return (
    <View style={styles.empty} testID="home__empty">
      <Text style={styles.emptyText}>
        {filtering ? "No worktree matches." : "This hub has no repos yet."}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  headerButton: { color: colors.foreground, fontSize: 17 },
  banner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 6,
    backgroundColor: colors.muted,
  },
  bannerText: { color: colors.foreground, fontSize: 13 },
  hubBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingTop: 10,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  hubName: { flex: 1, color: colors.foreground, fontSize: 14, fontWeight: "600" },
  status: { color: colors.foreground, fontSize: 13 },
  hubUrl: { color: colors.mutedForeground, fontSize: 12, paddingHorizontal: 16, paddingTop: 2 },
  tools: { flexDirection: "row", alignItems: "center", gap: 8, padding: 12 },
  search: {
    flex: 1,
    minHeight: 40,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    color: colors.foreground,
    paddingHorizontal: 12,
    fontSize: 16,
  },
  chip: {
    minHeight: 40,
    justifyContent: "center",
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 12,
  },
  chipOn: { backgroundColor: tones.attention, borderColor: tones.attention },
  chipText: { color: colors.foreground, fontSize: 14, fontWeight: "500" },
  chipTextOn: { color: colors.primaryForeground },
  list: { paddingBottom: 32, flexGrow: 1 },
  repoHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    minHeight: 44,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  chevron: { color: colors.mutedForeground, fontSize: 14, width: 14 },
  repoTitle: { flexShrink: 1, color: colors.foreground, fontSize: 17, fontWeight: "600" },
  repoCount: { color: colors.mutedForeground, fontSize: 14 },
  repoAttention: {
    borderRadius: 999,
    backgroundColor: tones.attention,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  repoAttentionText: { color: colors.primaryForeground, fontSize: 12, fontWeight: "700" },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, padding: 32 },
  emptyText: { color: colors.mutedForeground, fontSize: 15, textAlign: "center" },
});
