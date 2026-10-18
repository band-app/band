import { router, Stack } from "expo-router";
import { ChevronRight, type LucideIcon } from "lucide-react-native";
import type { ReactNode } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { colors } from "../theme";
import { Icon } from "./icon";

/** A Settings screen: a titled stack header and a scrolling body. */
export function SettingsScreen({
  title,
  testID,
  children,
}: {
  title: string;
  testID: string;
  children: ReactNode;
}) {
  return (
    <SafeAreaView style={styles.safe} edges={["bottom", "left", "right"]}>
      <Stack.Screen options={{ title }} />
      <ScrollView contentContainerStyle={styles.body} testID={testID}>
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

export function GroupTitle({ children }: { children: string }) {
  return <Text style={styles.groupTitle}>{children}</Text>;
}

/** A rounded card of rows. */
export function Group({ children, testID }: { children: ReactNode; testID?: string }) {
  return (
    <View style={styles.group} testID={testID}>
      {children}
    </View>
  );
}

/** A label with a value, lines of detail underneath and any controls on the right. */
export function Row({
  title,
  detail,
  value,
  right,
  testID,
  children,
}: {
  title: string;
  detail?: string | null;
  value?: string | null;
  right?: ReactNode;
  testID?: string;
  children?: ReactNode;
}) {
  return (
    <View style={styles.row} testID={testID}>
      <View style={styles.rowTop}>
        <View style={styles.rowText}>
          <Text style={styles.rowTitle}>{title}</Text>
          {detail ? <Text style={styles.rowDetail}>{detail}</Text> : null}
        </View>
        {value ? <Text style={styles.rowValue}>{value}</Text> : null}
        {right}
      </View>
      {children}
    </View>
  );
}

/** A row that opens another screen. */
export function LinkRow({
  title,
  detail,
  icon,
  href,
  testID,
}: {
  title: string;
  detail?: string;
  icon: LucideIcon;
  href: string;
  testID: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={() => router.push(href as never)}
      style={({ pressed }) => [styles.link, pressed && styles.dim]}
      testID={testID}
    >
      <Icon icon={icon} />
      <View style={styles.rowText}>
        <Text style={styles.rowTitle}>{title}</Text>
        {detail ? <Text style={styles.rowDetail}>{detail}</Text> : null}
      </View>
      <Icon icon={ChevronRight} size="sm" color={colors.faint} />
    </Pressable>
  );
}

export function SmallButton({
  label,
  onPress,
  destructive,
  disabled,
  busy,
  testID,
}: {
  label: string;
  onPress: () => void;
  destructive?: boolean;
  disabled?: boolean;
  busy?: boolean;
  testID: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || busy, busy }}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [styles.small, (pressed || disabled) && styles.dim]}
      testID={testID}
    >
      {busy ? (
        <ActivityIndicator size="small" color={colors.foreground} />
      ) : (
        <Text style={[styles.smallText, destructive && { color: colors.destructive }]}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

/** A quiet line of explanation: the admin-only notice, "update the hub", an empty list. */
export function Notice({
  children,
  testID,
  tone,
}: {
  children: ReactNode;
  testID?: string;
  tone?: "error" | "ok";
}) {
  return (
    <Text
      style={[
        styles.notice,
        tone === "error" && { color: colors.destructive },
        tone === "ok" && { color: colors.success },
      ]}
      accessibilityRole={tone === "error" ? "alert" : undefined}
      testID={testID}
    >
      {children}
    </Text>
  );
}

export function Loading({ testID }: { testID: string }) {
  return (
    <View style={styles.loading} testID={testID}>
      <ActivityIndicator color={colors.mutedForeground} />
    </View>
  );
}

/**
 * A confirm that fades in over the screen. Nothing happens until the confirm button; the scrim
 * and Cancel close it.
 */
export function ConfirmSheet({
  visible,
  title,
  message,
  confirmLabel,
  busy,
  disabled,
  error,
  onConfirm,
  onCancel,
  testID,
  destructive,
  children,
}: {
  visible: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  busy?: boolean;
  disabled?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  testID: string;
  destructive?: boolean;
  children?: ReactNode;
}) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <KeyboardAvoidingView behavior="padding" style={styles.modal}>
        <Pressable
          style={styles.scrim}
          onPress={busy ? undefined : onCancel}
          accessibilityRole="button"
          accessibilityLabel="Close"
          testID={`${testID}-scrim`}
        />
        <View style={styles.sheet} testID={testID}>
          <Text style={styles.sheetTitle} accessibilityRole="header">
            {title}
          </Text>
          <Text style={styles.sheetMessage}>{message}</Text>
          {children}
          {error ? <Notice tone="error">{error}</Notice> : null}
          <View style={styles.sheetButtons}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Cancel"
              disabled={busy}
              onPress={onCancel}
              style={[styles.sheetButton, styles.sheetCancel]}
              testID={`${testID}-cancel`}
            >
              <Text style={styles.sheetCancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={confirmLabel}
              accessibilityState={{ disabled: disabled || busy, busy }}
              disabled={disabled || busy}
              onPress={onConfirm}
              style={[
                styles.sheetButton,
                destructive ? styles.sheetDestructive : styles.sheetConfirm,
                (disabled || busy) && styles.dim,
              ]}
              testID={`${testID}-confirm`}
            >
              {busy ? (
                <ActivityIndicator color={colors.primaryForeground} />
              ) : (
                <Text style={styles.sheetConfirmText}>{confirmLabel}</Text>
              )}
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.background },
  body: { gap: 8, padding: 16 },
  groupTitle: { color: colors.mutedForeground, fontSize: 14, marginLeft: 4, marginTop: 10 },
  group: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  row: {
    borderBottomColor: colors.divider,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  rowTop: { alignItems: "center", flexDirection: "row", gap: 10 },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { color: colors.foreground, fontSize: 16 },
  rowDetail: { color: colors.mutedForeground, fontSize: 13, lineHeight: 18 },
  rowValue: { color: colors.mutedForeground, fontSize: 14 },
  link: {
    alignItems: "center",
    borderBottomColor: colors.divider,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 12,
    minHeight: 56,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  dim: { opacity: 0.55 },
  small: {
    alignItems: "center",
    backgroundColor: colors.muted,
    borderRadius: 16,
    justifyContent: "center",
    minHeight: 32,
    minWidth: 64,
    paddingHorizontal: 12,
  },
  smallText: { color: colors.foreground, fontSize: 14, fontWeight: "500" },
  notice: { color: colors.mutedForeground, fontSize: 14, lineHeight: 20, marginHorizontal: 4 },
  loading: { alignItems: "center", padding: 24 },
  modal: { flex: 1, justifyContent: "flex-end" },
  scrim: {
    backgroundColor: colors.scrim,
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
  sheet: {
    backgroundColor: colors.background,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    gap: 12,
    padding: 20,
    paddingBottom: 34,
  },
  sheetTitle: { color: colors.foreground, fontSize: 20, fontWeight: "600" },
  sheetMessage: { color: colors.mutedForeground, fontSize: 15, lineHeight: 21 },
  sheetButtons: { flexDirection: "row", gap: 10, marginTop: 4 },
  sheetButton: {
    alignItems: "center",
    borderRadius: 23,
    flex: 1,
    justifyContent: "center",
    minHeight: 46,
  },
  sheetCancel: { backgroundColor: colors.muted },
  sheetCancelText: { color: colors.foreground, fontSize: 16, fontWeight: "500" },
  sheetConfirm: { backgroundColor: colors.primary },
  sheetDestructive: { backgroundColor: colors.destructive },
  sheetConfirmText: { color: colors.primaryForeground, fontSize: 16, fontWeight: "600" },
});
