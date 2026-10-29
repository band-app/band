import {
  Asterisk,
  Check,
  Circle,
  FileDiff,
  type LucideIcon,
  MessageSquare,
  MinusCircle,
} from "lucide-react-native";
import { useState } from "react";
import { Image, StyleSheet, Text, View } from "react-native";
import {
  REVIEWER_STATE_LABEL,
  type ReviewerLike,
  type ReviewerState,
  reviewerInitial,
  reviewersSummary,
} from "../../lib/checks/reviewers";
import { colors, tones } from "../../theme";
import { Icon } from "../icon";

const STATE_TONE: Record<ReviewerState, string | typeof colors.mutedForeground> = {
  approved: tones.success,
  changes_requested: tones.failure,
  commented: tones.neutral,
  pending: tones.pending,
  dismissed: tones.neutral,
};

const STATE_ICON: Record<ReviewerState, LucideIcon> = {
  approved: Check,
  changes_requested: FileDiff,
  commented: MessageSquare,
  pending: Circle,
  dismissed: MinusCircle,
};

/** Avatar URLs that failed to load, so a remount shows the initial without a request. */
const failedAvatars = new Set<string>();

function Avatar({ login, url }: { login: string; url: string | null }) {
  const [, setFailures] = useState(0);
  if (url && !failedAvatars.has(url)) {
    return (
      <Image
        source={{ uri: url }}
        style={styles.avatar}
        accessibilityIgnoresInvertColors
        onError={() => {
          failedAvatars.add(url);
          setFailures((n) => n + 1);
        }}
        testID="pr-reviewers__avatar"
      />
    );
  }
  return (
    <View style={[styles.avatar, styles.avatarFallback]} testID="pr-reviewers__initial">
      <Text style={styles.initial}>{reviewerInitial(login)}</Text>
    </View>
  );
}

/** Who was asked to review the pull request and where each reviewer stands. */
export function ReviewersSection({ reviewers }: { reviewers: readonly ReviewerLike[] }) {
  return (
    <View style={styles.section} testID="pr-reviewers">
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Reviewers</Text>
        <Text style={styles.sectionSummary} testID="pr-reviewers__summary">
          {reviewersSummary(reviewers)}
        </Text>
      </View>
      {reviewers.length === 0 ? (
        <Text style={styles.empty} testID="pr-reviewers__empty">
          No reviewers requested yet.
        </Text>
      ) : (
        reviewers.map((reviewer) => (
          <View key={reviewer.login} style={styles.row} testID="pr-reviewers__reviewer">
            <Avatar login={reviewer.login} url={reviewer.avatarUrl} />
            <Text style={styles.login} numberOfLines={1} testID="pr-reviewers__login">
              {reviewer.login}
            </Text>
            {reviewer.required ? (
              <View accessible accessibilityLabel="Required" testID="pr-reviewers__required">
                <Icon icon={Asterisk} size="sm" color={colors.mutedForeground} />
              </View>
            ) : null}
            <Icon icon={STATE_ICON[reviewer.state]} size="sm" color={STATE_TONE[reviewer.state]} />
            <Text
              style={[styles.state, { color: STATE_TONE[reviewer.state] }]}
              testID="pr-reviewers__state"
            >
              {REVIEWER_STATE_LABEL[reviewer.state]}
            </Text>
          </View>
        ))
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: 8 },
  sectionHeader: {
    alignItems: "baseline",
    borderBottomColor: colors.divider,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  sectionTitle: { color: colors.foreground, fontSize: 15, fontWeight: "600" },
  sectionSummary: { color: colors.mutedForeground, fontSize: 13 },
  empty: {
    color: colors.mutedForeground,
    fontSize: 13,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  row: {
    alignItems: "center",
    borderBottomColor: colors.divider,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  avatar: { borderRadius: 10, height: 20, width: 20 },
  avatarFallback: {
    alignItems: "center",
    backgroundColor: colors.muted,
    justifyContent: "center",
  },
  initial: { color: colors.foreground, fontSize: 10, fontWeight: "600" },
  login: { color: colors.foreground, flex: 1, fontSize: 14, minWidth: 0 },
  state: { fontSize: 12 },
});
