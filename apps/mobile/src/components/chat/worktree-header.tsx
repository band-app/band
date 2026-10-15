import { router } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ChatTab } from "../../lib/chat/use-worktree-tabs";
import { colors, tones } from "../../theme";
import { BackGlyph, ChevronGlyph, DotsGlyph, Glass, GlassCircle } from "../glass";
import { StateIcon } from "../state-icon";

const DOT_COLOR = {
  attention: tones.attention,
  running: tones.running,
  unread: tones.success,
  idle: colors.grab,
};

/**
 * The worktree screen's top: a back circle, a centred title pill and a more circle. The pill names
 * the shown tab with its state, and a second line says where it is (`repo · branch · 2 of 3`);
 * tapping it opens the tab sheet. Dots under it mark every tab, colored by state, the shown one wide.
 */
export function WorktreeHeader({
  repo,
  branch,
  tabs,
  active,
  onOpenTabs,
  onMore,
}: {
  repo: string;
  branch: string;
  tabs: ChatTab[];
  active: string | null;
  onOpenTabs: () => void;
  onMore: () => void;
}) {
  const insets = useSafeAreaInsets();
  const index = tabs.findIndex((t) => t.id === active);
  const tab = index >= 0 ? tabs[index] : undefined;
  const where = [repo, branch, tab ? `${index + 1} of ${tabs.length}` : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <View style={[styles.root, { paddingTop: insets.top + 6 }]}>
      <View style={styles.bar}>
        <GlassCircle label="Back" onPress={() => router.back()} testID="worktree__back">
          <BackGlyph />
        </GlassCircle>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${tab?.label ?? "Chats"}, ${where}. Show all tabs`}
          onPress={onOpenTabs}
          style={styles.pillWrap}
          testID="tabs__switcher"
        >
          <Glass radius={24} innerStyle={styles.pill}>
            <View style={styles.line1}>
              {tab ? <StateIcon state={tab.shown} /> : null}
              <Text style={styles.name} numberOfLines={1} testID="worktree__name">
                {tab?.label ?? repo}
              </Text>
              <ChevronGlyph direction="down" size={7} />
            </View>
            <Text style={styles.where} numberOfLines={1} testID="worktree__branch">
              {where}
            </Text>
          </Glass>
        </Pressable>
        <GlassCircle label="More" onPress={onMore} testID="worktree__more">
          <DotsGlyph />
        </GlassCircle>
      </View>
      {tabs.length > 1 ? (
        <View style={styles.dots} testID="tabs__dots">
          {tabs.map((t) => (
            <View
              key={t.id}
              style={[
                styles.dot,
                { backgroundColor: DOT_COLOR[t.state] },
                t.id === active && styles.dotCurrent,
                t.id === active && t.state === "idle" && { backgroundColor: colors.foreground },
              ]}
              testID={`tabs__dot-${t.id}-${t.state}`}
              accessibilityLabel={t.id === active ? `${t.label}, shown` : t.label}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { backgroundColor: colors.background, paddingBottom: 6, zIndex: 3 },
  bar: { alignItems: "center", flexDirection: "row", gap: 10, paddingHorizontal: 12 },
  pillWrap: { flex: 1 },
  pill: { alignItems: "center", height: 48, justifyContent: "center", paddingHorizontal: 14 },
  line1: { alignItems: "center", flexDirection: "row", gap: 6, maxWidth: "100%" },
  name: { color: colors.foreground, flexShrink: 1, fontSize: 15, fontWeight: "600" },
  where: { color: colors.mutedForeground, fontSize: 11.5, marginTop: -1 },
  dots: { flexDirection: "row", gap: 6, justifyContent: "center", paddingTop: 8 },
  dot: { borderRadius: 3, height: 6, width: 6 },
  dotCurrent: { borderRadius: 3, width: 18 },
});
