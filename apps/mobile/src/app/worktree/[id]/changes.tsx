import { FlashList } from "@shopify/flash-list";
import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams } from "expo-router";
import { useMemo } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import { FileIcon } from "../../../components/file-icon";
import { ViewHeader } from "../../../components/files/view-header";
import { Body } from "../../../components/ui";
import {
  branchUnavailableMessage,
  type ChangeEntry,
  type ChangeListItem,
  changeListItems,
  countChanges,
  STATUS_NAMES,
} from "../../../lib/files/changes";
import { openDiff } from "../../../lib/files/open";
import { baseName, dirName } from "../../../lib/files/paths";
import { useWorktreeLabel } from "../../../lib/files/use-worktree-label";
import { SessionGate, useHubSession } from "../../../lib/hub-session";
import { colors, fonts, tones } from "../../../theme";

export default function ChangesRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <SessionGate>
      <Changes worktreeId={id} />
    </SessionGate>
  );
}

const STATUS_TONE = {
  A: tones.success,
  M: tones.attention,
  D: tones.failure,
  R: tones.merged,
  C: tones.merged,
  U: tones.neutral,
} as const;

/** The web re-reads the changes on an interval; so does this, and a pull reads them now. */
const REFRESH_MS = 10_000;

function Changes({ worktreeId }: { worktreeId: string }) {
  const { client } = useHubSession();
  const label = useWorktreeLabel(worktreeId);
  const changes = useQuery({
    queryKey: ["worktree.getChanges", worktreeId],
    queryFn: () => client.worktree.getChanges.query({ worktreeId }),
    refetchInterval: REFRESH_MS,
  });
  const data = changes.data;
  const items = useMemo(() => (data ? changeListItems(data) : []), [data]);
  const total = data ? countChanges(data) : 0;
  const unavailable =
    data && data.branch.length === 0 ? branchUnavailableMessage(data, data.headBranch) : null;
  return (
    <View style={styles.screen} testID="changes__screen">
      <ViewHeader
        title="Changes"
        subtitle={data ? `${total} file${total === 1 ? "" : "s"} · ${label}` : label}
        testID="changes"
      />
      {changes.error && !data ? (
        <View style={styles.center}>
          <Body testID="changes__error">{changes.error.message}</Body>
        </View>
      ) : !data ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.mutedForeground} />
        </View>
      ) : (
        <FlashList
          data={items}
          keyExtractor={(item) =>
            item.type === "header" ? `h:${item.section}` : `f:${item.section}:${item.entry.path}`
          }
          getItemType={(item) => item.type}
          onRefresh={() => void changes.refetch()}
          refreshing={changes.isRefetching}
          ListEmptyComponent={
            <Text style={styles.empty} testID="changes__empty">
              No changes
            </Text>
          }
          ListFooterComponent={
            unavailable ? (
              <Text style={styles.note} testID="changes__branch-unavailable">
                {unavailable}
              </Text>
            ) : null
          }
          renderItem={({ item }) => (
            <Item
              item={item}
              onOpen={(entry, section) =>
                openDiff(worktreeId, { ...entry, section, mergeBase: data.mergeBase })
              }
            />
          )}
          testID="changes__list"
        />
      )}
    </View>
  );
}

function Item({
  item,
  onOpen,
}: {
  item: ChangeListItem;
  onOpen: (entry: ChangeEntry, section: ChangeListItem["section"]) => void;
}) {
  if (item.type === "header") {
    return (
      <View style={styles.header} testID={`changes__section-${item.section}`}>
        <Text style={styles.headerText} accessibilityRole="header">
          {item.title}
        </Text>
        <Text style={styles.count} testID={`changes__count-${item.section}`}>
          {item.count}
        </Text>
      </View>
    );
  }
  const { entry } = item;
  const conflict = item.section === "conflicts";
  const tone = conflict ? tones.failure : STATUS_TONE[entry.status];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${baseName(entry.path)}, ${STATUS_NAMES[entry.status]}`}
      onPress={() => onOpen(entry, item.section)}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      testID={`changes__row-${item.section}-${entry.path}`}
    >
      <Text style={[styles.status, { color: tone }]}>{conflict ? "!" : entry.status}</Text>
      <FileIcon name={entry.path} />
      <View style={styles.names}>
        <Text style={styles.name} numberOfLines={1}>
          {baseName(entry.path)}
        </Text>
        <Text style={styles.where} numberOfLines={1}>
          {entry.oldPath ? `${entry.oldPath} → ` : ""}
          {dirName(entry.path) || "/"}
        </Text>
      </View>
      {entry.additions !== undefined || entry.deletions !== undefined ? (
        <Text style={styles.counts}>
          <Text style={{ color: tones.success }}>+{entry.additions ?? 0}</Text>{" "}
          <Text style={{ color: tones.failure }}>−{entry.deletions ?? 0}</Text>
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: colors.background, flex: 1 },
  center: { alignItems: "center", flex: 1, justifyContent: "center", padding: 20 },
  empty: { color: colors.mutedForeground, fontSize: 15, padding: 24, textAlign: "center" },
  note: { color: colors.mutedForeground, fontSize: 13, padding: 16 },
  header: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    paddingBottom: 6,
    paddingHorizontal: 16,
    paddingTop: 16,
  },
  headerText: {
    color: colors.mutedForeground,
    fontSize: 13,
    fontWeight: "600",
    textTransform: "uppercase",
  },
  count: { color: colors.mutedForeground, fontSize: 13 },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
    minHeight: 52,
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  pressed: { backgroundColor: colors.muted },
  status: {
    fontFamily: fonts.mono,
    fontSize: 14,
    fontWeight: "700",
    textAlign: "center",
    width: 16,
  },
  names: { flex: 1, gap: 1 },
  name: { color: colors.foreground, fontSize: 15 },
  where: { color: colors.mutedForeground, fontSize: 12 },
  counts: { fontFamily: fonts.mono, fontSize: 12 },
});
