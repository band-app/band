import type { LucideIcon } from "lucide-react-native";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { colors } from "../theme";
import { BottomSheet } from "./bottom-sheet";
import { Icon } from "./icon";

export interface ViewsSheetItem {
  key: string;
  title: string;
  icon: LucideIcon;
  subtitle?: string;
  onPress: () => void;
  destructive?: boolean;
  disabled?: boolean;
}

/**
 * The worktree header's "more" sheet. `views` are the screens a worktree opens (Checks, and the
 * Explorer and Changes rows other PRs add), `actions` are what the shown chat can do. A row's
 * `onPress` runs after the sheet has closed.
 */
export function ViewsSheet({
  visible,
  onClose,
  title,
  views,
  actions,
  onDismiss,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  views: ViewsSheetItem[];
  actions: ViewsSheetItem[];
  /** The sheet finished closing. */
  onDismiss?: () => void;
}) {
  const row = (item: ViewsSheetItem) => (
    <Pressable
      key={item.key}
      accessibilityRole="button"
      accessibilityState={{ disabled: item.disabled }}
      disabled={item.disabled}
      onPress={item.onPress}
      style={({ pressed }) => [styles.row, (pressed || item.disabled) && styles.dim]}
      testID={`views__${item.key}`}
    >
      <Icon icon={item.icon} color={item.destructive ? colors.destructive : colors.foreground} />
      <View style={styles.rowText}>
        <Text style={[styles.rowTitle, item.destructive && styles.destructive]}>{item.title}</Text>
        {item.subtitle ? <Text style={styles.rowSub}>{item.subtitle}</Text> : null}
      </View>
    </Pressable>
  );
  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      onDismiss={onDismiss}
      testID="views__sheet"
      backdropTestID="views__scrim"
    >
      <Text style={styles.title} accessibilityRole="header">
        Views
      </Text>
      <Text style={styles.sub} numberOfLines={1}>
        {title}
      </Text>
      <View style={styles.group}>{views.map(row)}</View>
      <View style={styles.group}>{actions.map(row)}</View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  title: { color: colors.foreground, fontSize: 20, fontWeight: "600", marginHorizontal: 4 },
  sub: { color: colors.mutedForeground, fontSize: 13, marginBottom: 12, marginHorizontal: 4 },
  group: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 12,
    overflow: "hidden",
  },
  row: {
    borderBottomColor: colors.divider,
    borderBottomWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
    minHeight: 50,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { color: colors.foreground, fontSize: 16 },
  rowSub: { color: colors.mutedForeground, fontSize: 13 },
  destructive: { color: colors.destructive },
  dim: { opacity: 0.5 },
});
