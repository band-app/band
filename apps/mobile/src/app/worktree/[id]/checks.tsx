import {
  CHECK_STATE_LABEL,
  type CheckLike,
  type CheckState,
  canRerun,
  checkDuration,
  checkElapsed,
  countChecks,
  isCountingUp,
} from "@band-app/client/checks";
import { FlashList } from "@shopify/flash-list";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { memo, useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { BackGlyph, Glass, GlassCircle } from "../../../components/glass";
import { Body, Centered } from "../../../components/ui";
import { useWorktreeChecks } from "../../../lib/checks/use-checks";
import { SessionGate } from "../../../lib/hub-session";
import { colors, tints, tones } from "../../../theme";

/** The worktree's Checks view: the pull request's CI checks, re-run, and the Fix agent. */
export default function ChecksRoute() {
  const { id, branch } = useLocalSearchParams<{ id: string; branch?: string }>();
  return (
    <SessionGate>
      <Stack.Screen options={{ headerShown: false }} />
      <ChecksScreen worktreeId={id} branch={branch ?? id} />
    </SessionGate>
  );
}

const STATE_TONE: Record<CheckState, string | typeof colors.mutedForeground> = {
  failure: tones.failure,
  running: tones.running,
  pending: tones.pending,
  cancelled: tones.neutral,
  success: tones.success,
  neutral: tones.neutral,
  skipped: tones.neutral,
};

const STATE_GLYPH: Record<CheckState, string> = {
  failure: "✕",
  running: "↻",
  pending: "◷",
  cancelled: "⊘",
  success: "✓",
  neutral: "–",
  skipped: "–",
};

function CheckIcon({ state }: { state: CheckState }) {
  return (
    <View
      style={[styles.icon, { borderColor: STATE_TONE[state] }]}
      accessibilityLabel={CHECK_STATE_LABEL[state]}
      testID={`checks__icon-${state}`}
    >
      {state === "running" ? (
        <ActivityIndicator size="small" color={tones.running} style={styles.iconSpinner} />
      ) : (
        <Text style={[styles.iconGlyph, { color: STATE_TONE[state] }]}>{STATE_GLYPH[state]}</Text>
      )}
    </View>
  );
}

function openUrl(url: string) {
  if (url.startsWith("https://") || url.startsWith("http://")) {
    void Linking.openURL(url).catch(() => {});
  }
}

function ChecksScreen({ worktreeId, branch }: { worktreeId: string; branch: string }) {
  const insets = useSafeAreaInsets();
  const checks = useWorktreeChecks(worktreeId, branch);
  const { data, shown, query } = checks;
  const [expanded, setExpanded] = useState<string | null>(null);

  // One timer for the list, so running checks count up together.
  const ticking = shown.some(isCountingUp);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);

  const fix = async () => {
    try {
      const chatId = await checks.startFix();
      // The worktree screen is under this one. It shows the new chat as the active tab.
      router.dismissTo({
        pathname: "/worktree/[id]",
        params: { id: worktreeId, openChat: chatId },
      });
    } catch (err) {
      Alert.alert("Couldn't start the fix", err instanceof Error ? err.message : String(err));
    }
  };

  const counts = countChecks(shown);
  const failing = shown.filter((c) => c.state === "failure");
  const review = data?.review ?? null;
  const subtitle = review ? `PR #${review.number} · ${review.title}` : (data?.branch ?? "");

  const renderItem = useCallback(
    ({ item }: { item: CheckLike }) => (
      <CheckRow
        check={item}
        now={isCountingUp(item) ? now : 0}
        open={expanded === item.id}
        rerunning={checks.rerunning.has(item.id)}
        rerunError={checks.rerunErrors[item.id] ?? null}
        onToggle={() => setExpanded((cur) => (cur === item.id ? null : item.id))}
        onRerun={checks.rerunOne}
      />
    ),
    [now, expanded, checks.rerunning, checks.rerunErrors, checks.rerunOne],
  );

  let body: React.ReactNode;
  if (!data) {
    const message =
      query.data && query.data.status !== "ok"
        ? query.data.message
        : query.error
          ? query.error.message
          : null;
    body = message ? (
      <Centered>
        <Body
          testID={query.data?.status === "unavailable" ? "checks__unavailable" : "checks__error"}
        >
          {message}
        </Body>
        {query.data?.status !== "unavailable" ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => void query.refetch()}
            style={styles.action}
            testID="checks__retry"
          >
            <Text style={styles.actionText}>Retry</Text>
          </Pressable>
        ) : null}
      </Centered>
    ) : (
      <Centered>
        <ActivityIndicator color={colors.mutedForeground} testID="checks__loading" />
      </Centered>
    );
  } else if (shown.length === 0) {
    body = (
      <Centered>
        <Body testID="checks__empty">
          {review
            ? "No checks reported for this pull request."
            : "No GitHub Actions jobs ran on this branch."}
        </Body>
      </Centered>
    );
  } else {
    body = (
      <FlashList
        data={shown}
        keyExtractor={(c) => c.id}
        renderItem={renderItem}
        extraData={{ now, expanded, rerunning: checks.rerunning, errors: checks.rerunErrors }}
        refreshControl={
          <RefreshControl refreshing={query.isRefetching} onRefresh={() => void query.refetch()} />
        }
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
        ListHeaderComponent={
          <View>
            {failing.length > 0 ? (
              <View style={styles.banner} testID="checks__failing-banner">
                <Text style={styles.bannerTitle} testID="checks__failing-count">
                  {failing.length} failing {failing.length === 1 ? "check" : "checks"}
                </Text>
                <Text style={styles.bannerText}>
                  {checks.rerunFailedError ?? "Inspect details or start an AI fix pass."}
                </Text>
                <View style={styles.bannerActions}>
                  {checks.canRerunFailed ? (
                    <Pressable
                      accessibilityRole="button"
                      disabled={checks.rerunFailedBusy}
                      onPress={() => void checks.rerunFailed()}
                      style={[styles.action, checks.rerunFailedBusy && styles.dim]}
                      testID="checks__rerun-failed"
                    >
                      <Text style={styles.actionText}>Re-run failed</Text>
                    </Pressable>
                  ) : null}
                  <Pressable
                    accessibilityRole="button"
                    disabled={checks.fixing}
                    onPress={() => void fix()}
                    style={[styles.action, styles.actionPrimary, checks.fixing && styles.dim]}
                    testID="checks__fix"
                  >
                    <Text style={[styles.actionText, styles.actionPrimaryText]}>Fix</Text>
                  </Pressable>
                </View>
              </View>
            ) : null}
            <View style={styles.summary} testID="checks__summary">
              {counts.passing > 0 ? (
                <Text
                  style={[styles.count, { color: tones.success }]}
                  testID="checks__count-passing"
                >
                  {counts.passing} passing
                </Text>
              ) : null}
              {counts.failing > 0 ? (
                <Text
                  style={[styles.count, { color: tones.failure }]}
                  testID="checks__count-failing"
                >
                  {counts.failing} failing
                </Text>
              ) : null}
              {counts.pending > 0 ? (
                <Text
                  style={[styles.count, { color: tones.pending }]}
                  testID="checks__count-pending"
                >
                  {counts.pending} pending
                </Text>
              ) : null}
            </View>
          </View>
        }
        testID="checks__list"
      />
    );
  }

  return (
    <View style={styles.screen} testID="checks__screen">
      <View style={[styles.header, { paddingTop: insets.top + 6 }]}>
        <GlassCircle label="Back" onPress={() => router.back()} testID="checks__back">
          <BackGlyph />
        </GlassCircle>
        <View style={styles.pillWrap}>
          <Glass radius={24} innerStyle={styles.pill}>
            <Text style={styles.name} numberOfLines={1} accessibilityRole="header">
              Checks
            </Text>
            {subtitle ? (
              <Text style={styles.where} numberOfLines={1} testID="checks__subtitle">
                {subtitle}
              </Text>
            ) : null}
          </Glass>
        </View>
        <View style={styles.headerSpacer} />
      </View>
      {body}
    </View>
  );
}

const CheckRow = memo(function CheckRow({
  check,
  now,
  open,
  rerunning,
  rerunError,
  onToggle,
  onRerun,
}: {
  check: CheckLike;
  now: number;
  open: boolean;
  rerunning: boolean;
  rerunError: string | null;
  onToggle: () => void;
  onRerun: (check: CheckLike) => void;
}) {
  const elapsed = checkDuration(check) ?? checkElapsed(check, now);
  // "Queued" says it already.
  const duration = elapsed === CHECK_STATE_LABEL[check.state] ? null : elapsed;
  return (
    <View style={styles.row}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${check.name}, ${CHECK_STATE_LABEL[check.state]}${duration ? `, ${duration}` : ""}`}
        onPress={onToggle}
        style={styles.rowPress}
        testID={`checks__check-${check.name}`}
      >
        <CheckIcon state={check.state} />
        <View style={styles.rowText}>
          <Text style={styles.rowName} numberOfLines={1}>
            {check.name}
          </Text>
          <Text style={styles.rowMeta} numberOfLines={1}>
            {CHECK_STATE_LABEL[check.state]}
            {duration ? ` · ${duration}` : ""}
          </Text>
        </View>
        <Text style={styles.chevron}>{open ? "⌃" : "⌄"}</Text>
      </Pressable>
      {open ? (
        <View style={styles.details} testID="checks__details">
          {check.workflowName ? (
            <Detail label="Workflow" value={check.workflowName} testID="checks__workflow" />
          ) : null}
          {check.description ? (
            <Detail label="Result" value={check.description} testID="checks__result" />
          ) : null}
          {check.startedAt ? (
            <Detail label="Started" value={new Date(check.startedAt).toLocaleString()} />
          ) : null}
          {duration ? <Detail label="Duration" value={duration} /> : null}
          <View style={styles.detailActions}>
            {check.url ? (
              <Pressable
                accessibilityRole="link"
                onPress={() => openUrl(check.url as string)}
                style={styles.action}
                testID="checks__open"
              >
                <Text style={styles.actionText}>Open in Safari</Text>
              </Pressable>
            ) : null}
            {canRerun(check) || rerunning ? (
              <Pressable
                accessibilityRole="button"
                disabled={rerunning}
                onPress={() => onRerun(check)}
                style={[styles.action, rerunning && styles.dim]}
                testID="checks__rerun"
              >
                <Text style={styles.actionText}>{rerunning ? "Re-running…" : "Re-run"}</Text>
              </Pressable>
            ) : null}
          </View>
          {rerunError ? (
            <Text style={styles.error} accessibilityRole="alert" testID="checks__rerun-error">
              {rerunError}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
});

function Detail({ label, value, testID }: { label: string; value: string; testID?: string }) {
  return (
    <View style={styles.detail}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue} selectable testID={testID}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: colors.background, flex: 1 },
  header: {
    alignItems: "center",
    backgroundColor: colors.background,
    flexDirection: "row",
    gap: 10,
    paddingBottom: 6,
    paddingHorizontal: 12,
    zIndex: 3,
  },
  pillWrap: { flex: 1 },
  pill: { alignItems: "center", height: 48, justifyContent: "center", paddingHorizontal: 14 },
  headerSpacer: { width: 44 },
  name: { color: colors.foreground, fontSize: 15, fontWeight: "600" },
  where: { color: colors.mutedForeground, fontSize: 11.5, marginTop: -1 },
  banner: {
    backgroundColor: tints.failure,
    borderRadius: 16,
    gap: 4,
    margin: 12,
    padding: 14,
  },
  bannerTitle: { color: tones.failure, fontSize: 15, fontWeight: "600" },
  bannerText: { color: colors.mutedForeground, fontSize: 13 },
  bannerActions: { flexDirection: "row", gap: 8, marginTop: 8 },
  action: {
    alignItems: "center",
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    height: 36,
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  actionPrimary: { backgroundColor: colors.primary, borderColor: colors.primary },
  actionText: { color: colors.foreground, fontSize: 14, fontWeight: "500" },
  actionPrimaryText: { color: colors.primaryForeground },
  dim: { opacity: 0.5 },
  summary: { flexDirection: "row", gap: 14, paddingHorizontal: 16, paddingVertical: 10 },
  count: { fontSize: 13, fontWeight: "600" },
  row: {
    borderBottomColor: colors.divider,
    borderBottomWidth: StyleSheet.hairlineWidth,
    marginHorizontal: 12,
  },
  rowPress: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
    minHeight: 58,
    paddingVertical: 10,
  },
  rowText: { flex: 1, minWidth: 0 },
  rowName: { color: colors.foreground, fontSize: 16, fontWeight: "500" },
  rowMeta: { color: colors.mutedForeground, fontSize: 13 },
  chevron: { color: colors.mutedForeground, fontSize: 16 },
  icon: {
    alignItems: "center",
    borderRadius: 11,
    borderWidth: 1.6,
    height: 22,
    justifyContent: "center",
    width: 22,
  },
  iconGlyph: { fontSize: 12, fontWeight: "800" },
  iconSpinner: { transform: [{ scale: 0.6 }] },
  details: { gap: 6, paddingBottom: 12, paddingLeft: 34 },
  detail: { flexDirection: "row", gap: 10 },
  detailLabel: { color: colors.mutedForeground, fontSize: 13, width: 72 },
  detailValue: { color: colors.foreground, flex: 1, fontSize: 13 },
  detailActions: { flexDirection: "row", gap: 8, marginTop: 6 },
  error: { color: colors.destructive, fontSize: 13 },
});
