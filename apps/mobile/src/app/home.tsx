import { Redirect, router } from "expo-router";
import { ChevronsDownUp, ChevronsUpDown, Settings as SettingsIcon, Tag } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
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
import { Icon } from "../components/icon";
import { ParentSheet } from "../components/parent-sheet";
import { avatarColor, initials, RepoAvatar } from "../components/repo-avatar";
import { StartSheet } from "../components/start-sheet";
import { Button } from "../components/ui";
import { WorktreeRowView } from "../components/worktree-row";
import { allCollapsed } from "../lib/collapsed-repos";
import { canDelete, deleteFailure, deletePrompt, removeRequest } from "../lib/deleting";
import { effectiveGroupFilter } from "../lib/group-filter";
import { SessionGate, useHubSession } from "../lib/hub-session";
import { useHubs } from "../lib/hubs-context";
import { resetTo } from "../lib/navigation";
import {
  type ParentCandidate,
  parentCandidates,
  removeFromGroupFailure,
  removeFromGroupRequests,
  setParentFailure,
  setParentRequests,
} from "../lib/parenting";
import { pinRequest } from "../lib/pinning";
import { renameFailure, renameRequest, rowTitle } from "../lib/renaming";
import { hasUnreadMark, unreadActionLabel, unreadRequest } from "../lib/unread";
import { useCollapsedRepos } from "../lib/use-collapsed-repos";
import { useGroupFilter } from "../lib/use-group-filter";
import {
  useCreateGroup,
  useGroups,
  useHosts,
  usePinWorktree,
  useRemoveFromGroup,
  useRemoveWorktree,
  useRenameWorktree,
  useReorderGroups,
  useRepos,
  useSetParent,
  useSetUnread,
  useStatusFeed,
} from "../lib/use-hub-data";
import { buildSections, findRow, type RepoSection, type WorktreeRow } from "../lib/worktree-list";
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
  const { collapsed, toggle, setMany } = useCollapsedRepos();
  const groups = useGroups();
  const [storedGroup, setGroupFilter] = useGroupFilter();
  const pin = usePinWorktree();
  const setUnread = useSetUnread();
  const remove = useRemoveWorktree();
  const setParent = useSetParent();
  const rename = useRenameWorktree();
  const removeFromGroup = useRemoveFromGroup();
  const createGroup = useCreateGroup();
  const reorderGroups = useReorderGroups();
  const [parentFor, setParentFor] = useState<WorktreeRow | null>(null);
  const [deleting, setDeleting] = useState<ReadonlySet<string>>(new Set());
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
  const groupList = groups.data;
  const groupFilter = useMemo(
    () => effectiveGroupFilter(storedGroup, groupList ?? []),
    [storedGroup, groupList],
  );
  const sections = useMemo(
    () =>
      buildSections(repoList ?? [], {
        statuses,
        hosts: hostList ?? [],
        collapsed,
        query,
        groups: groupList ?? [],
        groupFilter,
      }),
    [repoList, hostList, statuses, collapsed, query, groupList, groupFilter],
  );

  // The button folds every group and repo section the list shows, and unfolds the same ones. A
  // group the filter hides is not listed, so it keeps its state.
  const foldable = useMemo(
    () => sections.filter((s) => s.kind === "group" || s.kind === "repo").map((s) => s.name),
    [sections],
  );
  const everythingFolded = allCollapsed(collapsed, foldable);

  const groupActions = useCallback(
    (groupId: string, name: string) => {
      const ids = (groupList ?? []).map((g) => g.id);
      const at = ids.indexOf(groupId);
      const move = (to: number) => {
        const next = [...ids];
        [next[at], next[to]] = [next[to], next[at]];
        reorderGroups.mutate(next);
      };
      const actions: { label: string; run: () => void }[] = [
        ...(at > 0 ? [{ label: "Move up", run: () => move(at - 1) }] : []),
        ...(at >= 0 && at < ids.length - 1
          ? [{ label: "Move down", run: () => move(at + 1) }]
          : []),
      ];
      if (actions.length === 0) return;
      const options = [...actions.map((a) => a.label), "Cancel"];
      ActionSheetIOS.showActionSheetWithOptions(
        { title: name, options, cancelButtonIndex: options.length - 1 },
        (index) => actions[index]?.run(),
      );
    },
    [groupList, reorderGroups],
  );

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await Promise.all([repos.refetch(), hosts.refetch()]);
    } finally {
      setRefreshing(false);
    }
  }, [repos, hosts]);

  const chooseGroup = useCallback(() => {
    const defined = groupList ?? [];
    const options = ["All", ...defined.map((l) => l.name), "New group…", "Cancel"];
    ActionSheetIOS.showActionSheetWithOptions(
      { title: "Filter by group", options, cancelButtonIndex: options.length - 1 },
      (index) => {
        if (index === 0) setGroupFilter(null);
        else if (index <= defined.length) setGroupFilter(defined[index - 1]?.id ?? null);
        else if (index === defined.length + 1) {
          Alert.prompt("New group", undefined, (name) => {
            if (name?.trim()) createGroup.mutate(name.trim());
          });
        }
      },
    );
  }, [groupList, setGroupFilter, createGroup]);

  const confirmDelete = useCallback(
    (row: WorktreeRow) => {
      const prompt = deletePrompt(row);
      Alert.alert(prompt.title, prompt.message, [
        { text: "Cancel", style: "cancel" },
        {
          text: prompt.confirm,
          style: "destructive",
          onPress: () => {
            setDeleting((ids) => new Set(ids).add(row.id));
            remove.mutate(removeRequest(row), {
              onError: (error) => {
                const failure = deleteFailure(row, error);
                Alert.alert(failure.title, failure.message);
              },
              onSettled: () =>
                setDeleting((ids) => {
                  const next = new Set(ids);
                  next.delete(row.id);
                  return next;
                }),
            });
          },
        },
      ]);
    },
    [remove],
  );

  const rowActions = useCallback(
    (row: WorktreeRow) => {
      const deletable = canDelete(row);
      const actions: { label: string; run: () => void; destructive?: boolean }[] = [
        {
          label: row.pinned ? "Unpin" : "Pin",
          run: () => pin.mutate(pinRequest(row, !row.pinned)),
        },
        {
          label: unreadActionLabel(row),
          run: () => setUnread.mutate(unreadRequest(row, !hasUnreadMark(row))),
        },
        {
          label: "Rename…",
          run: () =>
            Alert.prompt(
              "Rename worktree",
              "Leave it empty to show the original name.",
              (typed) =>
                rename.mutate(renameRequest(row, typed), {
                  onError: (error) => {
                    const failure = renameFailure(row, error);
                    Alert.alert(failure.title, failure.message);
                  },
                }),
              "plain-text",
              row.title ?? row.name,
            ),
        },
        { label: "Set parent…", run: () => setParentFor(row) },
        ...(row.parentId
          ? [
              {
                label: "Remove parent",
                run: () =>
                  setParent.mutate(setParentRequests(row, null), {
                    onError: (error) => {
                      const failure = setParentFailure(row, error);
                      Alert.alert(failure.title, failure.message);
                    },
                  }),
              },
            ]
          : []),
        ...(row.groupId
          ? [
              {
                label: "Remove from group",
                run: () => {
                  const parentGroupId = row.parentId
                    ? (findRow(repoList ?? [], row.parentId, statuses, hostList ?? [])?.groupId ??
                      null)
                    : null;
                  removeFromGroup.mutate(removeFromGroupRequests(row, parentGroupId), {
                    onError: (error) => {
                      const failure = removeFromGroupFailure(row, error);
                      Alert.alert(failure.title, failure.message);
                    },
                  });
                },
              },
            ]
          : []),
        ...(deletable
          ? [{ label: "Delete worktree", run: () => confirmDelete(row), destructive: true }]
          : []),
      ];
      const options = [...actions.map((a) => a.label), "Cancel"];
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: rowTitle(row),
          options,
          cancelButtonIndex: options.length - 1,
          ...(deletable ? { destructiveButtonIndex: actions.length - 1 } : {}),
        },
        (index) => actions[index]?.run(),
      );
    },
    [
      pin,
      setUnread,
      rename,
      confirmDelete,
      setParent,
      removeFromGroup,
      repoList,
      statuses,
      hostList,
    ],
  );

  const candidates = useMemo<ParentCandidate[]>(
    () => (parentFor ? parentCandidates(repoList ?? [], parentFor) : []),
    [parentFor, repoList],
  );

  const loading = repos.isPending || !clientStateReady;
  const filtering = query.trim() !== "";
  const activeGroup = groupList?.find((g) => g.id === groupFilter) ?? null;
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
            label="Settings"
            onPress={() => router.push("/settings")}
            testID="home__settings"
          >
            <Icon icon={SettingsIcon} />
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
      {sections.length > 0 || (groupList?.length ?? 0) > 0 ? (
        <View style={styles.sectionRow} testID="home__list-controls">
          <Text style={styles.sectionLabel}>
            {(groupList?.length ?? 0) > 0 ? "Groups" : "Repos"}
          </Text>
          <View style={styles.controls}>
            <Pressable
              onPress={() => setMany(foldable, !everythingFolded)}
              accessibilityRole="button"
              accessibilityLabel={everythingFolded ? "Expand all" : "Collapse all"}
              testID="home__toggle-all"
              style={styles.groupBy}
            >
              <Icon icon={everythingFolded ? ChevronsUpDown : ChevronsDownUp} size="sm" />
            </Pressable>
            <Pressable
              onPress={chooseGroup}
              accessibilityRole="button"
              accessibilityLabel={`Filter by group, ${activeGroup?.name ?? "All"}`}
              testID="home__group-filter"
              style={styles.groupBy}
            >
              <Tag size={13} color={colors.foreground} />
              <Text style={styles.groupByText}>{activeGroup?.name ?? "All"}</Text>
              <ChevronGlyph direction="down" size={7} color={colors.foreground} />
            </Pressable>
          </View>
        </View>
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
            filtering={filtering}
            avatarBase={hub.url}
            token={hub.token}
            onToggle={() => toggle(section.name)}
            onGroupMenu={() =>
              section.group?.id ? groupActions(section.group.id, section.title) : undefined
            }
          />
        )}
        renderItem={({ item, index, section }) => (
          <WorktreeRowView
            row={item}
            first={section.kind !== "repo" && index === 0}
            last={index === section.data.length - 1}
            onPress={() => router.push({ pathname: "/worktree/[id]", params: { id: item.id } })}
            deleting={deleting.has(item.id)}
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
      <ParentSheet
        visible={parentFor !== null}
        rowName={parentFor?.name ?? ""}
        candidates={candidates}
        onClose={() => setParentFor(null)}
        onPick={(candidate) => {
          if (parentFor) {
            setParent.mutate(setParentRequests(parentFor, candidate), {
              onError: (error) => {
                const failure = setParentFailure(parentFor, error);
                Alert.alert(failure.title, failure.message);
              },
            });
          }
          setParentFor(null);
        }}
      />
      <StartSheet visible={starting} onClose={() => setStarting(false)} repos={repoList ?? []} />
    </View>
  );
}

function SectionHeader({
  section,
  filtering,
  avatarBase,
  token,
  onToggle,
  onGroupMenu,
}: {
  section: RepoSection;
  filtering: boolean;
  avatarBase: string;
  token: string;
  onToggle: () => void;
  /** Long press on a group header: Move up and Move down. */
  onGroupMenu: () => void;
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
      {section.kind === "top" ? null : section.kind === "group" ? (
        <Pressable
          onPress={onToggle}
          onLongPress={onGroupMenu}
          disabled={filtering}
          accessibilityRole="button"
          accessibilityLabel={`${section.title}, ${section.total} worktrees, ${section.collapsed ? "collapsed" : "expanded"}`}
          accessibilityHint="Long press to move the group"
          accessibilityState={{ expanded: !section.collapsed }}
          testID={`home__${section.name}`}
          style={styles.groupRow}
        >
          {section.group?.color ? (
            <View style={[styles.groupDot, { backgroundColor: section.group.color }]} />
          ) : (
            <View style={[styles.groupDot, styles.groupDotEmpty]} />
          )}
          <Text style={styles.groupName} numberOfLines={1}>
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
      ) : (
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
  groupRow: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    marginBottom: 6,
    marginHorizontal: 20,
    marginTop: 14,
    minHeight: 32,
  },
  groupName: { color: colors.foreground, flex: 1, fontSize: 14, fontWeight: "600" },
  groupDot: { borderRadius: 5, height: 10, width: 10 },
  groupDotEmpty: { borderColor: colors.faint, borderWidth: 1.5 },
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
