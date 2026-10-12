import { Pressable, StyleSheet, Text, View } from "react-native";
import type { AgentState } from "../lib/status-state";
import type { CiTone, PullRequestTone, WorktreeRow } from "../lib/worktree-list";
import { colors, tones } from "../theme";

export const STATE_LABEL: Record<AgentState, string> = {
  running: "Running",
  attention: "Needs attention",
  idle: "Idle",
};

const STATE_COLOR: Record<AgentState, string> = {
  running: tones.running,
  attention: tones.attention,
  idle: tones.neutral,
};

const PR_COLOR: Record<PullRequestTone, string> = {
  failure: tones.failure,
  pending: tones.pending,
  success: tones.success,
  neutral: tones.neutral,
  merged: tones.merged,
  closed: tones.neutral,
};

const CI_COLOR: Record<CiTone, string> = {
  failure: tones.failure,
  pending: tones.pending,
  success: tones.success,
  merged: tones.merged,
};

const CI_LABEL: Record<CiTone, string> = {
  failure: "CI failing",
  pending: "CI running",
  success: "CI passed",
  merged: "Merged",
};

/** The spoken form of a row, also what Maestro matches on. */
export function rowLabel(row: WorktreeRow): string {
  const parts = [row.name, row.branch, row.hostTag, STATE_LABEL[row.agent]];
  if (row.pr) parts.push(`PR ${row.pr.number}`);
  return parts.join(", ");
}

export function PullRequestTag({ row }: { row: WorktreeRow }) {
  if (!row.pr || !row.prTone) return null;
  const color = PR_COLOR[row.prTone];
  return (
    <View style={[styles.prTag, { borderColor: color }]}>
      <Text
        style={[styles.prText, { color }, row.prTone === "closed" && styles.struck]}
        testID={`worktree__pr-${row.id}`}
      >
        #{row.pr.number}
      </Text>
    </View>
  );
}

export function CiDot({ row }: { row: WorktreeRow }) {
  if (!row.ciTone) return null;
  return (
    <View
      style={[styles.ciDot, { backgroundColor: CI_COLOR[row.ciTone] }]}
      accessibilityLabel={CI_LABEL[row.ciTone]}
      testID={`worktree__ci-${row.id}`}
    />
  );
}

export function StatePill({ row }: { row: WorktreeRow }) {
  const color = STATE_COLOR[row.agent];
  return (
    <View
      style={[
        styles.pill,
        { borderColor: color },
        row.agent === "attention" && { backgroundColor: color },
      ]}
    >
      <Text
        style={[
          styles.pillText,
          { color: row.agent === "attention" ? colors.primaryForeground : color },
        ]}
      >
        {STATE_LABEL[row.agent]}
      </Text>
    </View>
  );
}

export function WorktreeRowView({ row, onPress }: { row: WorktreeRow; onPress: () => void }) {
  const attention = row.agent === "attention";
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={rowLabel(row)}
      testID={`home__worktree-${row.id}`}
      style={({ pressed }) => [
        styles.row,
        attention && styles.rowAttention,
        pressed && styles.rowPressed,
      ]}
    >
      <View style={[styles.stripe, { backgroundColor: STATE_COLOR[row.agent] }]} />
      <View style={styles.body}>
        <View style={styles.titleLine}>
          {row.pinned ? <Text style={styles.pin}>★</Text> : null}
          <Text style={[styles.name, attention && styles.nameAttention]} numberOfLines={1}>
            {row.name}
          </Text>
          <PullRequestTag row={row} />
          <CiDot row={row} />
        </View>
        <Text style={styles.meta} numberOfLines={1}>
          {row.branch} · {row.hostTag}
          {row.missing ? " · folder missing" : ""}
          {row.lifecycle ? ` · ${row.lifecycle}` : ""}
        </Text>
      </View>
      <StatePill row={row} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: 60,
    paddingRight: 14,
    marginHorizontal: 12,
    marginBottom: 6,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    overflow: "hidden",
  },
  rowAttention: { borderColor: tones.attention, backgroundColor: "#2a1f16" },
  rowPressed: { opacity: 0.7 },
  stripe: { alignSelf: "stretch", width: 5 },
  body: { flex: 1, paddingVertical: 10, gap: 3 },
  titleLine: { flexDirection: "row", alignItems: "center", gap: 6 },
  pin: { color: colors.mutedForeground, fontSize: 12 },
  name: { flexShrink: 1, color: colors.foreground, fontSize: 16, fontWeight: "500" },
  nameAttention: { fontWeight: "700" },
  meta: { color: colors.mutedForeground, fontSize: 13 },
  pill: { borderRadius: 999, borderWidth: 1, paddingHorizontal: 9, paddingVertical: 3 },
  pillText: { fontSize: 12, fontWeight: "600" },
  prTag: { borderWidth: 1, borderRadius: 4, paddingHorizontal: 4, paddingVertical: 1 },
  prText: { fontSize: 11, fontWeight: "600" },
  struck: { textDecorationLine: "line-through" },
  ciDot: { width: 9, height: 9, borderRadius: 5 },
});
