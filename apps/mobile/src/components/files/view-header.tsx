import { router } from "expo-router";
import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors } from "../../theme";
import { BackGlyph, Glass, GlassCircle } from "../glass";

/**
 * The top of a worktree view (Explorer, a file, Changes, a diff): a back circle and a title pill
 * with a second line, like the worktree screen's header. `right` sits after the pill.
 */
export function ViewHeader({
  title,
  subtitle,
  icon,
  right,
  testID,
}: {
  title: string;
  subtitle?: string;
  /** A file-type icon shown before the title. */
  icon?: ReactNode;
  right?: ReactNode;
  testID: string;
}) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.root, { paddingTop: insets.top + 6 }]}>
      <View style={styles.bar}>
        <GlassCircle label="Back" onPress={() => router.back()} testID={`${testID}__back`}>
          <BackGlyph />
        </GlassCircle>
        <View style={styles.pillWrap}>
          <Glass radius={24} innerStyle={styles.pill}>
            <View style={styles.titleRow}>
              {icon}
              <Text style={styles.title} numberOfLines={1} testID={`${testID}__title`}>
                {title}
              </Text>
            </View>
            {subtitle ? (
              <Text style={styles.subtitle} numberOfLines={1} testID={`${testID}__subtitle`}>
                {subtitle}
              </Text>
            ) : null}
          </Glass>
        </View>
        {right ?? <View style={styles.spacer} />}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { backgroundColor: colors.background, paddingBottom: 8, zIndex: 3 },
  bar: { alignItems: "center", flexDirection: "row", gap: 10, paddingHorizontal: 12 },
  pillWrap: { flex: 1 },
  pill: { alignItems: "center", height: 48, justifyContent: "center", paddingHorizontal: 14 },
  titleRow: { alignItems: "center", flexDirection: "row", gap: 6, maxWidth: "100%" },
  title: { color: colors.foreground, fontSize: 15, fontWeight: "600", flexShrink: 1 },
  subtitle: { color: colors.mutedForeground, fontSize: 11.5, marginTop: -1, maxWidth: "100%" },
  spacer: { width: 44 },
});
