import { useState } from "react";
import { RefreshControl, StyleSheet, Text, View } from "react-native";
import { Group, Loading, Notice, Row, SettingsScreen } from "../../components/settings-ui";
import { SessionGate } from "../../lib/hub-session";
import { errorText } from "../../lib/settings/errors";
import {
  accountLine,
  problemKey,
  providerName,
  roundedPercent,
  rowKey,
  type UsageDataLike,
  type UsageRowLike,
  usageTone,
  usageView,
  windowResetText,
} from "../../lib/settings/usage";
import { useAccountUsage } from "../../lib/use-settings-data";
import { colors } from "../../theme";

export default function Usage() {
  return (
    <SessionGate>
      <UsageScreen />
    </SessionGate>
  );
}

function UsageScreen() {
  const { query, refresh } = useAccountUsage();
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const pull = () => {
    setRefreshError(null);
    refresh.mutate(undefined, { onError: (err) => setRefreshError(errorText(err)) });
  };

  const view = usageView({
    data: query.data as UsageDataLike | undefined,
    pending: query.isPending,
    error: query.isError ? errorText(query.error) : null,
    refreshError,
  });

  return (
    <SettingsScreen
      title="Usage"
      testID="settings__usage"
      refreshControl={
        <RefreshControl
          refreshing={refresh.isPending}
          onRefresh={pull}
          tintColor={colors.mutedForeground}
        />
      }
    >
      <Notice>Limits of the Claude and Codex accounts logged in on online workers.</Notice>
      {view.kind === "loading" ? <Loading testID="settings__usage-loading" /> : null}
      {view.kind === "error" ? (
        <Notice tone="error" testID="settings__usage-error">
          {view.message}
        </Notice>
      ) : null}
      {view.kind === "data" || view.kind === "empty" ? (
        view.refreshError ? (
          <Notice tone="error" testID="settings__usage-refresh-error">
            Couldn't refresh usage. {view.refreshError}
          </Notice>
        ) : null
      ) : null}
      {view.kind === "empty" ? (
        <Notice testID="settings__usage-empty">No Claude or Codex accounts found.</Notice>
      ) : null}
      {view.kind === "data"
        ? view.rows.map((row) => <UsageAccount key={rowKey(row)} row={row} />)
        : null}
      {view.kind === "data" && view.problems.length > 0 ? (
        <Group testID="settings__usage-problems">
          {view.problems.map((p) => (
            <Row
              key={problemKey(p)}
              testID="settings__usage-problem"
              title={providerName(p.provider)}
              detail={p.message}
            />
          ))}
        </Group>
      ) : null}
    </SettingsScreen>
  );
}

function UsageAccount({ row }: { row: UsageRowLike }) {
  const name = providerName(row.provider);
  return (
    <Group testID={`settings__usage-${row.provider}`}>
      <Row
        title={name}
        detail={accountLine(row)}
        value={row.plan}
        testID={`settings__usage-${row.provider}-account`}
      >
        {row.windows.map((w) => {
          const percent = roundedPercent(w.percent);
          const reset = windowResetText(w.resetsAt);
          return (
            <View key={w.label} style={styles.window} testID="settings__usage-window">
              <View style={styles.windowTop}>
                <Text style={styles.windowLabel}>{w.label}</Text>
                <Text style={styles.windowPercent}>{percent}%</Text>
              </View>
              <View
                style={styles.track}
                accessibilityRole="progressbar"
                accessibilityLabel={`${name} ${w.label}`}
                accessibilityValue={{ min: 0, max: 100, now: percent }}
              >
                <View
                  style={[
                    styles.fill,
                    { width: `${percent}%`, backgroundColor: toneColor(w.percent) },
                  ]}
                />
              </View>
              {reset ? <Text style={styles.reset}>{reset}</Text> : null}
            </View>
          );
        })}
      </Row>
    </Group>
  );
}

function toneColor(percent: number) {
  const tone = usageTone(percent);
  return tone === "danger"
    ? colors.destructive
    : tone === "warning"
      ? colors.warning
      : colors.success;
}

const styles = StyleSheet.create({
  window: { gap: 4, marginTop: 10 },
  windowTop: { flexDirection: "row", justifyContent: "space-between" },
  windowLabel: { color: colors.mutedForeground, fontSize: 13 },
  windowPercent: { color: colors.foreground, fontSize: 13, fontVariant: ["tabular-nums"] },
  track: { backgroundColor: colors.muted, borderRadius: 4, height: 6, overflow: "hidden" },
  fill: { borderRadius: 4, height: 6 },
  reset: { color: colors.mutedForeground, fontSize: 12 },
});
