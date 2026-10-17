import { FlashList } from "@shopify/flash-list";
import { useQuery } from "@tanstack/react-query";
import { useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { FrameLog } from "../../../components/chat/frame-log";
import { ViewHeader } from "../../../components/files/view-header";
import { ChevronGlyph, SearchGlyph } from "../../../components/glass";
import { Body } from "../../../components/ui";
import type { TreeRow } from "../../../lib/files/file-tree";
import { openFile } from "../../../lib/files/open";
import { baseName, dirName } from "../../../lib/files/paths";
import { useFileTree } from "../../../lib/files/use-file-tree";
import { useWorktreeLabel } from "../../../lib/files/use-worktree-label";
import { SessionGate, useHubSession } from "../../../lib/hub-session";
import { useDebounced } from "../../../lib/use-debounced";
import { colors, fonts, useScheme } from "../../../theme";

export default function ExplorerRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return (
    <SessionGate>
      <Explorer worktreeId={id} />
    </SessionGate>
  );
}

type Mode = "name" | "content";

function Explorer({ worktreeId }: { worktreeId: string }) {
  const label = useWorktreeLabel(worktreeId);
  const scheme = useScheme();
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<Mode>("name");
  const searching = query.trim().length > 0;
  // Owned here so typing a search and clearing it keeps the open folders.
  const tree = useFileTree(worktreeId);
  return (
    <View style={styles.screen} testID="explorer__screen">
      <ViewHeader title="Explorer" subtitle={label} testID="explorer" />
      <View style={styles.searchRow}>
        <View style={styles.field}>
          <SearchGlyph size={16} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={mode === "name" ? "Find a file by name" : "Search in files"}
            placeholderTextColor={colors.mutedForeground}
            keyboardAppearance={scheme}
            autoCapitalize="none"
            autoCorrect={false}
            clearButtonMode="while-editing"
            returnKeyType="search"
            style={styles.input}
            accessibilityLabel="Search files"
            testID="explorer__search"
          />
        </View>
        <View style={styles.modes}>
          {(["name", "content"] as const).map((m) => (
            <Pressable
              key={m}
              accessibilityRole="button"
              accessibilityState={{ selected: mode === m }}
              onPress={() => setMode(m)}
              style={[styles.mode, mode === m && styles.modeOn]}
              testID={`explorer__mode-${m}`}
            >
              <Text style={[styles.modeText, mode === m && styles.modeTextOn]}>
                {m === "name" ? "Name" : "Content"}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
      {process.env.EXPO_PUBLIC_BAND_PERF_LOG === "1" ? <FrameLog /> : null}
      {searching ? (
        <SearchResults worktreeId={worktreeId} query={query} mode={mode} />
      ) : (
        <Tree worktreeId={worktreeId} tree={tree} />
      )}
    </View>
  );
}

function Tree({ worktreeId, tree }: { worktreeId: string; tree: ReturnType<typeof useFileTree> }) {
  if (tree.error && !tree.ready) {
    return (
      <View style={styles.center}>
        <Body testID="explorer__error">{tree.error}</Body>
      </View>
    );
  }
  if (!tree.ready) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.mutedForeground} />
      </View>
    );
  }
  return (
    <>
      {tree.error ? (
        <Text style={styles.banner} testID="explorer__tree-error">
          {tree.error}
        </Text>
      ) : null}
      <FlashList
        data={tree.rows}
        keyExtractor={(row) => row.path}
        getItemType={(row) => row.type}
        maintainVisibleContentPosition={{ disabled: true }}
        onRefresh={tree.refresh}
        refreshing={tree.refreshing}
        contentInsetAdjustmentBehavior="automatic"
        ListEmptyComponent={
          <Text style={styles.empty} testID="explorer__empty">
            This folder has no files.
          </Text>
        }
        renderItem={({ item }) => (
          <TreeRowView
            row={item}
            onPress={() =>
              item.type === "directory" ? tree.toggle(item.path) : openFile(worktreeId, item.path)
            }
          />
        )}
        testID="explorer__tree"
      />
    </>
  );
}

function TreeRowView({ row, onPress }: { row: TreeRow; onPress: () => void }) {
  const dir = row.type === "directory";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${row.name}${dir ? (row.expanded ? ", folder, open" : ", folder, closed") : ""}`}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      testID={`explorer__row-${row.path}`}
    >
      <View style={{ width: row.depth * 16 }} />
      <View style={styles.chevron}>
        {dir ? <ChevronGlyph direction={row.expanded ? "down" : "right"} size={7} /> : null}
      </View>
      <Text style={[styles.name, dir && styles.dirName]} numberOfLines={1}>
        {row.name}
      </Text>
      {row.loading ? <ActivityIndicator size="small" color={colors.mutedForeground} /> : null}
    </Pressable>
  );
}

function SearchResults({
  worktreeId,
  query,
  mode,
}: {
  worktreeId: string;
  query: string;
  mode: Mode;
}) {
  const { client } = useHubSession();
  const settled = useDebounced(query.trim(), 250);
  const files = useQuery({
    queryKey: ["worktree.searchFiles", worktreeId, settled],
    queryFn: () => client.worktree.searchFiles.query({ worktreeId, query: settled, limit: 200 }),
    enabled: mode === "name" && settled.length > 0,
    placeholderData: (previous) => previous,
  });
  const content = useQuery({
    queryKey: ["worktree.searchContent", worktreeId, settled],
    queryFn: () => client.worktree.searchContent.query({ worktreeId, query: settled, limit: 100 }),
    enabled: mode === "content" && settled.length > 0,
    placeholderData: (previous) => previous,
  });
  const active = mode === "name" ? files : content;
  if (active.error) {
    return (
      <View style={styles.center}>
        <Body testID="explorer__search-error">{active.error.message}</Body>
      </View>
    );
  }
  if (mode === "name") {
    const paths = files.data?.files ?? [];
    return (
      <FlashList
        data={paths}
        keyExtractor={(p) => p}
        keyboardShouldPersistTaps="handled"
        onRefresh={() => void files.refetch()}
        refreshing={files.isRefetching}
        ListEmptyComponent={
          <Text style={styles.empty} testID="explorer__no-results">
            {files.isFetching ? "Searching…" : "No files match."}
          </Text>
        }
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            onPress={() => openFile(worktreeId, item)}
            style={({ pressed }) => [styles.result, pressed && styles.pressed]}
            testID={`explorer__result-${item}`}
          >
            <Text style={styles.name} numberOfLines={1}>
              {baseName(item)}
            </Text>
            <Text style={styles.where} numberOfLines={1}>
              {dirName(item) || "/"}
            </Text>
          </Pressable>
        )}
        testID="explorer__results"
      />
    );
  }
  const matches = content.data?.results ?? [];
  return (
    <FlashList
      data={matches}
      keyExtractor={(m) => `${m.file}:${m.line}`}
      keyboardShouldPersistTaps="handled"
      onRefresh={() => void content.refetch()}
      refreshing={content.isRefetching}
      ListEmptyComponent={
        <Text style={styles.empty} testID="explorer__no-results">
          {content.isFetching ? "Searching…" : "No lines match."}
        </Text>
      }
      renderItem={({ item }) => (
        <Pressable
          accessibilityRole="button"
          onPress={() => openFile(worktreeId, item.file, item.line)}
          style={({ pressed }) => [styles.result, pressed && styles.pressed]}
          testID={`explorer__match-${item.file}:${item.line}`}
        >
          <Text style={styles.where} numberOfLines={1}>
            {item.file}:{item.line}
          </Text>
          <Text style={styles.matchText} numberOfLines={2}>
            {item.content.trim()}
          </Text>
        </Pressable>
      )}
      testID="explorer__matches"
    />
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: colors.background, flex: 1 },
  searchRow: { gap: 8, paddingBottom: 8, paddingHorizontal: 12 },
  field: {
    alignItems: "center",
    backgroundColor: colors.muted,
    borderRadius: 12,
    flexDirection: "row",
    gap: 8,
    height: 40,
    paddingHorizontal: 12,
  },
  input: { color: colors.foreground, flex: 1, fontSize: 16, height: 40 },
  modes: {
    alignSelf: "flex-start",
    backgroundColor: colors.muted,
    borderRadius: 10,
    flexDirection: "row",
    padding: 2,
  },
  mode: { borderRadius: 8, paddingHorizontal: 14, paddingVertical: 5 },
  modeOn: { backgroundColor: colors.card },
  modeText: { color: colors.mutedForeground, fontSize: 13, fontWeight: "500" },
  modeTextOn: { color: colors.foreground },
  center: { alignItems: "center", flex: 1, justifyContent: "center", padding: 20 },
  banner: {
    color: colors.mutedForeground,
    fontSize: 13,
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  empty: { color: colors.mutedForeground, fontSize: 15, padding: 24, textAlign: "center" },
  row: { alignItems: "center", flexDirection: "row", gap: 6, height: 40, paddingHorizontal: 12 },
  pressed: { backgroundColor: colors.muted },
  chevron: { alignItems: "center", width: 16 },
  name: { color: colors.foreground, flexShrink: 1, fontSize: 15 },
  dirName: { fontWeight: "600" },
  result: { gap: 2, paddingHorizontal: 16, paddingVertical: 9 },
  where: { color: colors.mutedForeground, fontSize: 12 },
  matchText: { color: colors.foreground, fontFamily: fonts.mono, fontSize: 12.5 },
});
