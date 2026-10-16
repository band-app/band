import { Redirect, router } from "expo-router";
import { Layers, Tag } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActionSheetIOS,
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
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ChevronGlyph, Glass, GlassCircle, PlusGlyph, SearchGlyph } from "../components/glass";
import { avatarColor, initials, RepoAvatar } from "../components/repo-avatar";
import { StartSheet } from "../components/start-sheet";
import { Button } from "../components/ui";
import { WorktreeRowView } from "../components/worktree-row";
import { SessionGate, useHubSession } from "../lib/hub-session";
import { useHubs } from "../lib/hubs-context";
import { effectiveLabelFilter } from "../lib/label-filter";
import { resetTo } from "../lib/navigation";
import { pinRequest } from "../lib/pinning";
import { useCollapsedRepos } from "../lib/use-collapsed-repos";
import { useGroupBy } from "../lib/use-group-by";
import { useHosts, useLabels, usePinWorktree, useRepos, useStatusFeed } from "../lib/use-hub-data";
import { useLabelFilter } from "../lib/use-label-filter";
import {
  buildSections,
  GROUP_BY_OPTIONS,
  type RepoSection,
  type WorktreeRow,
} from "../lib/worktree-list";
import { colors, tones, useScheme } from "../theme";

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
  const { clientStateReady, hub } = useHubSession();
  const insets = useSafeAreaInsets();
  const scheme = useScheme();
  const repos = useRepos();
  const hosts = useHosts();
  const { state: statuses, connection: stream } = useStatusFeed();
  const { collapsed, toggle } = useCollapsedRepos();
  const [groupBy, setGroupBy] = useGroupBy();
  const labels = useLabels();
  const [storedLabel, setLabelFilter] = useLabelFilter();
  const pin = usePinWorktree();
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [starting, setStarting] = useState(false);
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
  const labelList = labels.data;
  const labelFilter = useMemo(
    () => effectiveLabelFilter(storedLabel, labelList ?? []),
    [storedLabel, labelList],
  );
  const sections = useMemo(
    () =>
      buildSections(repoList ?? [], {
        statuses,
        hosts: hostList ?? [],
        collapsed,
        query,
        groupBy,
        labels: labelList ?? [],
        labelFilter,
      }),
    [repoList, hostList, statuses, collapsed, query, groupBy, labelList, labelFilter],
  );

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([repos.refetch(), hosts.refetch()]);
    } finally {
      setRefreshing(false);
    }
  }, [repos, hosts]);

  const chooseGroupBy = useCallback(() => {
    const options = [...GROUP_BY_OPTIONS.map((o) => o.label), "Cancel"];
    ActionSheetIOS.showActionSheetWithOptions(
      { title: "Group by", options, cancelButtonIndex: options.length - 1 },
      (index) => {
        const choice = GROUP_BY_OPTIONS[index];
        if (choice) setGroupBy(choice.value);
      },
    );
  }, [setGroupBy]);

  const chooseLabel = useCallback(() => {
    const defined = labelList ?? [];
    const options = ["All", ...defined.map((l) => l.name), "Cancel"];
    ActionSheetIOS.showActionSheetWithOptions(
      { title: "Filter by label", options, cancelButtonIndex: options.length - 1 },
      (index) => {
        if (index === 0) setLabelFilter(null);
        else if (index <= defined.length) setLabelFilter(defined[index - 1]?.id ?? null);
      },
    );
  }, [labelList, setLabelFilter]);

  const rowActions = useCallback(
    (row: WorktreeRow) => {
      const options = [row.pinned ? "Unpin" : "Pin", "Cancel"];
      ActionSheetIOS.showActionSheetWithOptions(
        { title: row.name, options, cancelButtonIndex: 1 },
        (index) => {
          if (index === 0) pin.mutate(pinRequest(row, !row.pinned));
        },
      );
    },
    [pin],
  );

  const loading = repos.isPending || !clientStateReady;
  const filtering = query.trim() !== "";
  const groupLabel = GROUP_BY_OPTIONS.find((o) => o.value === groupBy)?.label ?? "Repo";
  const activeLabel = labelList?.find((l) => l.id === labelFilter) ?? null;
  const hubLabel = active?.label ?? "Band";

  return (
    <View style={styles.screen} testID="home__screen">
      {stream === "reconnecting" ? (
        <View style={[styles.banner, { paddingTop: insets.top + 4 }]} testID="home__reconnecting">
          <ActivityIndicator color={colors.foreground} size="small" />
          <Text style={styles.bannerText}>Reconnecting…</Text>
        </View>
      ) : null}
      <View style={[styles.top, stream === "reconnecting" ? null : { paddingTop: insets.top + 6 }]}>
        <Pressable
          onPress={() => router.push("/hubs")}
          accessibilityRole="button"
          accessibilityLabel={`${hubLabel}, hubs`}
          testID="home__hubs"
          style={styles.hub}
        >
          <View style={[styles.avatar, { backgroundColor: avatarColor(hubLabel) }]}>
            <Text style={styles.avatarText}>{initials(hubLabel)}</Text>
          </View>
          <View style={styles.hubText}>
            <Text style={styles.hubName} numberOfLines={1} testID="home__hub-name">
              {hubLabel}
            </Text>
            <View style={styles.hubStatusLine}>
              <View
                style={[
                  styles.dot,
                  {
                    backgroundColor:
                      connection.state === "connected" ? colors.success : colors.warning,
                  },
                ]}
              />
              <Text style={styles.status} testID="home__status">
                {connection.state === "connected" ? "Connected" : "Checking…"}
              </Text>
            </View>
          </View>
        </Pressable>
        <View style={styles.actions}>
          <GlassCircle
            label="Search"
            onPress={() => {
              setSearching((on) => !on);
              if (searching) setQuery("");
            }}
            testID="home__search-toggle"
          >
            <SearchGlyph />
          </GlassCircle>
          <GlassCircle
            label="New worktree"
            onPress={() => setStarting(true)}
            testID="home__new-worktree"
          >
            <PlusGlyph />
          </GlassCircle>
        </View>
      </View>
      <Text style={styles.hubUrl} testID="home__hub-url">
        {active?.url}
      </Text>
      {searching || filtering ? (
        <TextInput
          keyboardAppearance={scheme}
          value={query}
          onChangeText={setQuery}
          placeholder="Search worktrees"
          placeholderTextColor={colors.faint}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          clearButtonMode="while-editing"
          returnKeyType="search"
          style={styles.search}
          accessibilityLabel="Search worktrees"
          testID="home__search"
        />
      ) : null}
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
            tintColor={colors.mutedForeground}
          />
        }
        renderSectionHeader={({ section }) => (
          <SectionHeader
            section={section}
            first={section === sections.find((s) => s.kind !== "pinned")}
            groupLabel={groupLabel}
            labelName={labelList && labelList.length > 0 ? (activeLabel?.name ?? "All") : null}
            filtering={filtering}
            avatarBase={hub.url}
            token={hub.token}
            onToggle={() => toggle(section.name)}
            onGroupBy={chooseGroupBy}
            onLabel={chooseLabel}
          />
        )}
        renderItem={({ item, index, section }) => (
          <WorktreeRowView
            row={item}
            first={(section.kind === "pinned" || section.kind === "origin") && index === 0}
            last={index === section.data.length - 1}
            onPress={() => router.push({ pathname: "/worktree/[id]", params: { id: item.id } })}
            onLongPress={() => rowActions(item)}
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
        contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 110 }]}
        testID="home__list"
      />
      <Pressable
        onPress={() => setStarting(true)}
        accessibilityRole="button"
        accessibilityLabel="Start an agent"
        testID="home__composer"
        style={[styles.composerWrap, { bottom: insets.bottom + 10 }]}
      >
        <Glass radius={28} innerStyle={styles.composer}>
          <View style={styles.composerPlus}>
            <PlusGlyph size={18} />
          </View>
          <Text style={styles.composerPlaceholder}>Plan, ask, build…</Text>
        </Glass>
      </Pressable>
      <StartSheet visible={starting} onClose={() => setStarting(false)} repos={repoList ?? []} />
    </View>
  );
}

function SectionHeader({
  section,
  first,
  groupLabel,
  labelName,
  filtering,
  avatarBase,
  token,
  onToggle,
  onGroupBy,
  onLabel,
}: {
  section: RepoSection;
  first: boolean;
  groupLabel: string;
  /** The filter's current name, or null when the hub defines no labels. */
  labelName: string | null;
  filtering: boolean;
  avatarBase: string;
  token: string;
  onToggle: () => void;
  onGroupBy: () => void;
  onLabel: () => void;
}) {
  if (section.kind === "pinned") {
    return (
      <View style={styles.sectionRow}>
        <Text style={styles.sectionLabel}>Pinned</Text>
      </View>
    );
  }
  return (
    <View>
      {first ? (
        <View style={styles.sectionRow}>
          <Text style={styles.sectionLabel}>
            {groupLabel === "Host" ? "Hosts" : groupLabel === "Origin" ? "Origin" : "Repos"}
          </Text>
          <View style={styles.controls}>
            {labelName !== null ? (
              <Pressable
                onPress={onLabel}
                accessibilityRole="button"
                accessibilityLabel={`Filter by label, ${labelName}`}
                testID="home__label-filter"
                style={styles.groupBy}
              >
                <Tag size={13} color={colors.foreground} />
                <Text style={styles.groupByText}>{labelName}</Text>
                <ChevronGlyph direction="down" size={7} color={colors.foreground} />
              </Pressable>
            ) : null}
            <Pressable
              onPress={onGroupBy}
              accessibilityRole="button"
              accessibilityLabel={`Group by ${groupLabel}`}
              testID="home__group-by"
              style={styles.groupBy}
            >
              <Layers size={13} color={colors.foreground} />
              <Text style={styles.groupByText}>{groupLabel}</Text>
              <ChevronGlyph direction="down" size={7} color={colors.foreground} />
            </Pressable>
          </View>
        </View>
      ) : null}
      {section.labelHeader ? (
        <View
          style={styles.labelRow}
          testID={`home__label-group-${section.labelHeader.id ?? "none"}`}
        >
          {section.labelHeader.color ? (
            <View style={[styles.labelDot, { backgroundColor: section.labelHeader.color }]} />
          ) : (
            <View style={[styles.labelDot, styles.labelDotEmpty]} />
          )}
          <Text style={styles.labelName}>{section.labelHeader.name}</Text>
        </View>
      ) : null}
      {section.kind === "origin" ? null : (
        <Pressable
          onPress={onToggle}
          disabled={filtering}
          accessibilityRole="button"
          accessibilityLabel={`${section.title}, ${section.total} worktrees, ${section.collapsed ? "collapsed" : "expanded"}`}
          accessibilityState={{ expanded: !section.collapsed }}
          testID={`home__repo-${section.name}`}
          style={[styles.repoHeader, section.collapsed && styles.repoHeaderCollapsed]}
        >
          {section.kind === "repo" ? (
            <RepoAvatar
              name={section.title}
              src={section.avatar?.src}
              base={avatarBase}
              token={token}
            />
          ) : null}
          <Text style={styles.repoTitle} numberOfLines={1}>
            {section.title}
          </Text>
          {section.collapsed && section.attention > 0 ? (
            <View style={styles.repoAttention} testID={`home__repo-attention-${section.name}`}>
              <Text style={styles.repoAttentionText}>{section.attention} need you</Text>
            </View>
          ) : null}
          <Text style={styles.repoCount}>{section.total}</Text>
          <ChevronGlyph
            direction={section.collapsed ? "right" : "down"}
            size={7}
            color={colors.faint}
          />
        </Pressable>
      )}
    </View>
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
        <ActivityIndicator color={colors.mutedForeground} />
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

const CARD_RADIUS = 18;

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  banner: {
    alignItems: "center",
    backgroundColor: colors.muted,
    flexDirection: "row",
    gap: 8,
    justifyContent: "center",
    paddingBottom: 6,
  },
  bannerText: { color: colors.foreground, fontSize: 13 },
  top: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingBottom: 6,
    paddingHorizontal: 16,
  },
  hub: { alignItems: "center", flexDirection: "row", flexShrink: 1, gap: 10 },
  hubText: { flexShrink: 1, gap: 1 },
  avatar: {
    alignItems: "center",
    borderRadius: 22,
    height: 44,
    justifyContent: "center",
    width: 44,
  },
  avatarText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  hubName: { color: colors.foreground, fontSize: 17, fontWeight: "600" },
  hubStatusLine: { alignItems: "center", flexDirection: "row", gap: 5 },
  dot: { borderRadius: 3.5, height: 7, width: 7 },
  status: { color: colors.mutedForeground, fontSize: 12.5 },
  hubUrl: { color: colors.faint, fontSize: 12, paddingHorizontal: 20, paddingBottom: 4 },
  actions: { flexDirection: "row", gap: 8 },
  search: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    color: colors.foreground,
    fontSize: 16,
    height: 44,
    marginBottom: 4,
    marginHorizontal: 16,
    paddingHorizontal: 16,
  },
  list: { flexGrow: 1 },
  sectionRow: {
    alignItems: "baseline",
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 6,
    marginHorizontal: 20,
    marginTop: 18,
  },
  sectionLabel: { color: colors.mutedForeground, fontSize: 14 },
  controls: { alignItems: "center", flexDirection: "row", gap: 14 },
  groupBy: { alignItems: "center", flexDirection: "row", gap: 5 },
  labelRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    marginBottom: 2,
    marginHorizontal: 20,
    marginTop: 14,
  },
  labelDot: { borderRadius: 5, height: 10, width: 10 },
  labelDotEmpty: { borderColor: colors.faint, borderWidth: 1.5 },
  labelName: { color: colors.foreground, fontSize: 13, fontWeight: "600" },
  groupByText: { color: colors.foreground, fontSize: 13 },
  repoHeader: {
    alignItems: "center",
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderTopLeftRadius: CARD_RADIUS,
    borderTopRightRadius: CARD_RADIUS,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 10,
    marginHorizontal: 16,
    marginTop: 8,
    minHeight: 44,
    paddingHorizontal: 14,
  },
  repoHeaderCollapsed: {
    borderBottomLeftRadius: CARD_RADIUS,
    borderBottomRightRadius: CARD_RADIUS,
  },
  repoTitle: { color: colors.foreground, flex: 1, fontSize: 14, fontWeight: "600" },
  repoCount: { color: colors.faint, fontSize: 13 },
  repoAttention: {
    backgroundColor: tones.attention,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  repoAttentionText: { color: "#fff", fontSize: 12, fontWeight: "700" },
  empty: { alignItems: "center", flex: 1, gap: 12, justifyContent: "center", padding: 32 },
  emptyText: { color: colors.mutedForeground, fontSize: 15, textAlign: "center" },
  composerWrap: { left: 12, position: "absolute", right: 12 },
  composer: { alignItems: "center", flexDirection: "row", gap: 10, minHeight: 56, padding: 6 },
  composerPlus: {
    alignItems: "center",
    backgroundColor: colors.muted,
    borderRadius: 22,
    height: 44,
    justifyContent: "center",
    width: 44,
  },
  composerPlaceholder: { color: colors.faint, flex: 1, fontSize: 16 },
});
