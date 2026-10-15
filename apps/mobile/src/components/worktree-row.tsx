import { Pressable, StyleSheet, Text, View } from "react-native";
import type { CiTone, PullRequestTone, WorktreeRow } from "../lib/worktree-list";
import { colors, tints, tones } from "../theme";
import { SHOWN_LABEL, StateIcon } from "./state-icon";

const PR_COLOR: Record<PullRequestTone, { fg: typeof tones.failure; bg: typeof tints.failure }> = {
  failure: { fg: tones.failure, bg: tints.failure },
  pending: { fg: tones.pending, bg: tints.pending },
  success: { fg: tones.success, bg: tints.success },
  neutral: { fg: colors.mutedForeground, bg: tints.neutral },
  merged: { fg: tones.merged, bg: tints.merged },
  closed: { fg: colors.mutedForeground, bg: tints.neutral },
};

const CI_COLOR: Record<CiTone, typeof tones.failure> = {
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
  const parts = [row.name, row.branch, row.hostTag, SHOWN_LABEL[row.shown]];
  if (row.pr) parts.push(`PR ${row.pr.number}`);
  return parts.join(", ");
}

/** The PR number on a tinted chip, colored by CI state as the web's badge is. */
export function PullRequestTag({ row }: { row: WorktreeRow }) {
  if (!row.pr || !row.prTone) return null;
  const { fg, bg } = PR_COLOR[row.prTone];
  return (
    <View style={[styles.pr, { backgroundColor: bg }]}>
      <Text
        style={[styles.prText, { color: fg }, row.prTone === "closed" && styles.struck]}
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

/** Ahead count, dirty marker, PR chip (or CI dot) and the host tag of a worktree not on the hub. */
export function RowMeta({ row, showHost = true }: { row: WorktreeRow; showHost?: boolean }) {
  return (
    <View style={styles.meta}>
      {row.ahead > 0 ? (
        <Text style={styles.metaText} testID={`worktree__ahead-${row.id}`}>
          ↑{row.ahead}
        </Text>
      ) : null}
      {row.dirty ? <View style={styles.dirty} accessibilityLabel="Uncommitted changes" /> : null}
      <PullRequestTag row={row} />
      <CiDot row={row} />
      {showHost && row.remote ? (
        <View style={styles.tag}>
          <Text style={styles.tagText} numberOfLines={1} testID={`worktree__host-${row.id}`}>
            {row.hostTag}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

export function WorktreeRowView({
  row,
  onPress,
  first,
  last,
}: {
  row: WorktreeRow;
  onPress: () => void;
  /** First row of a card with no header of its own (Pinned): round the top. */
  first?: boolean;
  last?: boolean;
}) {
  const attention = row.shown === "question";
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={rowLabel(row)}
      testID={`home__worktree-${row.id}`}
      style={({ pressed }) => [
        styles.row,
        first && styles.first,
        last && styles.last,
        !first && styles.divided,
        pressed && styles.pressed,
      ]}
    >
      <View style={{ width: row.depth * 16 }} />
      <StateIcon state={row.shown} />
      <View style={styles.body}>
        <Text style={[styles.name, attention && styles.nameStrong]} numberOfLines={1}>
          {row.name}
        </Text>
        {row.subtitle ? (
          <Text style={styles.sub} numberOfLines={1} testID={`home__subtitle-${row.id}`}>
            {row.subtitle}
          </Text>
        ) : null}
      </View>
      <RowMeta row={row} />
    </Pressable>
  );
}

const CARD_RADIUS = 18;

export const rowCard = {
  backgroundColor: colors.card,
  borderColor: colors.border,
  borderLeftWidth: StyleSheet.hairlineWidth,
  borderRightWidth: StyleSheet.hairlineWidth,
} as const;

const styles = StyleSheet.create({
  row: {
    ...rowCard,
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
    marginHorizontal: 16,
    minHeight: 54,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  divided: { borderTopColor: colors.divider, borderTopWidth: StyleSheet.hairlineWidth },
  first: {
    borderTopLeftRadius: CARD_RADIUS,
    borderTopRightRadius: CARD_RADIUS,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  last: {
    borderBottomLeftRadius: CARD_RADIUS,
    borderBottomRightRadius: CARD_RADIUS,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    marginBottom: 4,
  },
  pressed: { opacity: 0.6 },
  body: { flex: 1, gap: 1, minWidth: 0 },
  name: { color: colors.foreground, fontSize: 16 },
  nameStrong: { fontWeight: "600" },
  sub: { color: colors.mutedForeground, fontSize: 12.5 },
  meta: { alignItems: "center", flexDirection: "row", gap: 6 },
  metaText: { color: colors.mutedForeground, fontSize: 12.5 },
  dirty: { width: 6, height: 6, borderRadius: 3, backgroundColor: tones.pending },
  pr: { borderRadius: 8, paddingHorizontal: 7, paddingVertical: 2 },
  prText: { fontSize: 12.5, fontWeight: "600" },
  struck: { textDecorationLine: "line-through" },
  ciDot: { width: 9, height: 9, borderRadius: 5 },
  tag: {
    backgroundColor: tints.neutral,
    borderRadius: 6,
    maxWidth: 90,
    paddingHorizontal: 6,
    paddingVertical: 1,
  },
  tagText: { color: colors.mutedForeground, fontSize: 11 },
});
