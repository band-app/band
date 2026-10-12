import type { TranscriptState } from "@band-app/client/transcript";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors, tones } from "../../theme";

type PlanEntry = TranscriptState["plan"][number];

const MARKS: Record<PlanEntry["status"], string> = {
  completed: "✓",
  in_progress: "◐",
  pending: "○",
};

/**
 * The agent's current plan (ACP `plan`, Claude Code's todos), pinned under the transcript while
 * any entry is unfinished, like the web chat's task list.
 */
export function PlanCard({ plan }: { plan: PlanEntry[] }) {
  const [collapsed, setCollapsed] = useState(false);
  if (plan.length === 0 || plan.every((t) => t.status === "completed")) return null;
  const done = plan.filter((t) => t.status === "completed").length;
  return (
    <View style={styles.card} testID="chat__plan">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: !collapsed }}
        onPress={() => setCollapsed((c) => !c)}
        style={styles.header}
      >
        <Text style={styles.title}>{collapsed ? "▸" : "▾"} Todos</Text>
        <Text style={styles.count}>
          {done}/{plan.length}
        </Text>
      </Pressable>
      {collapsed
        ? null
        : plan.map((task, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: plan entries have no id; each update replaces the whole plan
            <View key={i} style={styles.entry} testID="chat__plan-entry">
              <Text
                style={[
                  styles.mark,
                  task.status === "in_progress" && { color: tones.running },
                  task.status === "completed" && { color: tones.success },
                ]}
              >
                {MARKS[task.status]}
              </Text>
              <Text style={[styles.text, task.status === "completed" && styles.done]}>
                {task.content}
              </Text>
            </View>
          ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.background,
    borderColor: colors.border,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    marginHorizontal: 12,
    marginTop: 6,
    paddingBottom: 6,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  title: { color: colors.foreground, fontSize: 14, fontWeight: "600" },
  count: { color: colors.mutedForeground, fontSize: 13 },
  entry: { flexDirection: "row", gap: 8, paddingHorizontal: 12, paddingVertical: 2 },
  mark: { color: colors.mutedForeground, fontSize: 14, width: 16 },
  text: { color: colors.foreground, flexShrink: 1, fontSize: 14 },
  done: { color: colors.mutedForeground, textDecorationLine: "line-through" },
});
