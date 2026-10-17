import { Modal, Pressable, StyleSheet, Text, View } from "react-native";

import { colors } from "../theme";

export interface ViewsSheetItem {
  key: string;
  title: string;
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
      <Text style={[styles.rowTitle, item.destructive && styles.destructive]}>{item.title}</Text>
      {item.subtitle ? <Text style={styles.rowSub}>{item.subtitle}</Text> : null}
    </Pressable>
  );
  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
      onDismiss={onDismiss}
    >
      <View style={styles.modal}>
        <Pressable
          style={styles.scrim}
          onPress={onClose}
          accessibilityLabel="Close"
          accessibilityRole="button"
          testID="views__scrim"
        />
        <View style={styles.sheet} testID="views__sheet">
          <View style={styles.grab} />
          <Text style={styles.title} accessibilityRole="header">
            Views
          </Text>
          <Text style={styles.sub} numberOfLines={1}>
            {title}
          </Text>
          <View style={styles.group}>{views.map(row)}</View>
          <View style={styles.group}>{actions.map(row)}</View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modal: { flex: 1, justifyContent: "flex-end" },
  scrim: { backgroundColor: colors.scrim, flex: 1 },
  sheet: {
    backgroundColor: colors.background,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingBottom: 34,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  grab: {
    alignSelf: "center",
    backgroundColor: colors.grab,
    borderRadius: 3,
    height: 5,
    marginBottom: 12,
    width: 38,
  },
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
    gap: 2,
    justifyContent: "center",
    minHeight: 50,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  rowTitle: { color: colors.foreground, fontSize: 16 },
  rowSub: { color: colors.mutedForeground, fontSize: 13 },
  destructive: { color: colors.destructive },
  dim: { opacity: 0.5 },
});
