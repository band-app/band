import { useEffect, useMemo, useState } from "react";
import { FlatList, Pressable, StyleSheet, Text, TextInput } from "react-native";
import type { ParentCandidate } from "../lib/parenting";
import { colors, useScheme } from "../theme";
import { BottomSheet } from "./bottom-sheet";

/** Picks the worktree a row was started from. Lists every worktree except the row and its descendants. */
export function ParentSheet({
  visible,
  rowName,
  candidates,
  onClose,
  onPick,
}: {
  visible: boolean;
  rowName: string;
  candidates: readonly ParentCandidate[];
  onClose: () => void;
  onPick: (candidate: ParentCandidate) => void;
}) {
  const scheme = useScheme();
  const [query, setQuery] = useState("");
  // Each opening starts with an empty search.
  useEffect(() => {
    if (!visible) setQuery("");
  }, [visible]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q
      ? candidates.filter((c) => `${c.repo} ${c.name}`.toLowerCase().includes(q))
      : candidates;
  }, [candidates, query]);
  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      style={styles.sheet}
      testID="parent-sheet"
      accessibilityLabel={`Set parent of ${rowName}`}
    >
      <Text style={styles.title}>Set parent of {rowName}</Text>
      <TextInput
        keyboardAppearance={scheme}
        value={query}
        onChangeText={setQuery}
        placeholder="Search worktrees"
        placeholderTextColor={colors.faint}
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.search}
        accessibilityLabel="Search worktrees"
        testID="parent-sheet__search"
      />
      <FlatList
        data={shown}
        keyExtractor={(c) => c.id}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => (
          <Pressable
            onPress={() => onPick(item)}
            accessibilityRole="button"
            accessibilityLabel={`${item.repo}, ${item.name}`}
            testID={`parent-sheet__item-${item.id}`}
            style={styles.item}
          >
            <Text style={styles.itemText} numberOfLines={1}>
              {item.repo} · {item.name}
            </Text>
          </Pressable>
        )}
        ListEmptyComponent={<Text style={styles.empty}>No worktrees found.</Text>}
      />
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  sheet: { gap: 10, maxHeight: "75%", padding: 16 },
  title: { color: colors.foreground, fontSize: 16, fontWeight: "600" },
  search: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    color: colors.foreground,
    fontSize: 16,
    height: 44,
    paddingHorizontal: 12,
  },
  item: { justifyContent: "center", minHeight: 44 },
  itemText: { color: colors.foreground, fontSize: 15 },
  empty: { color: colors.mutedForeground, fontSize: 14, paddingVertical: 12 },
});
