import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import {
  ConfirmSheet,
  Group,
  Loading,
  Notice,
  Row,
  SettingsScreen,
  SmallButton,
} from "../../components/settings-ui";
import { SessionGate } from "../../lib/hub-session";
import { errorText, isMissingProcedure } from "../../lib/settings/errors";
import {
  type HostLike,
  interruptionLines,
  isUpdating,
  lastSeenText,
  showUpdateButton,
  updateButtonLabel,
  updateProgressText,
  versionStateLabel,
  versionText,
} from "../../lib/settings/hosts";
import {
  useCurrentToken,
  useDismissUpdate,
  useInterruptions,
  useLiveHosts,
  useUpdateHost,
} from "../../lib/use-settings-data";
import { colors, tones } from "../../theme";

export default function Hosts() {
  return (
    <SessionGate>
      <HostsScreen />
    </SessionGate>
  );
}

function HostsScreen() {
  const hosts = useLiveHosts();
  const current = useCurrentToken();
  const isAdmin = current.data?.admin === true;
  const [updating, setUpdating] = useState<HostLike | null>(null);

  return (
    <SettingsScreen title="Workers" testID="settings__hosts">
      <Notice>Computers that run worktrees. Workers connect to the hub and appear here.</Notice>
      {hosts.isPending ? <Loading testID="settings__hosts-loading" /> : null}
      {hosts.isError ? (
        <Notice tone="error" testID="settings__hosts-error">
          {isMissingProcedure(hosts.error) ? errorText(hosts.error) : "Could not load the workers."}
        </Notice>
      ) : null}
      {hosts.data ? (
        <Group testID="settings__host-list">
          {hosts.data.map((host) => (
            <HostRow
              key={host.id}
              host={host as unknown as HostLike}
              isAdmin={isAdmin}
              onUpdate={() => setUpdating(host as unknown as HostLike)}
            />
          ))}
        </Group>
      ) : null}
      {current.isSuccess && !isAdmin ? (
        <Notice testID="settings__hosts-not-admin">Updating a worker needs an admin token.</Notice>
      ) : null}
      {updating ? <UpdateConfirm host={updating} onClose={() => setUpdating(null)} /> : null}
    </SettingsScreen>
  );
}

function HostRow({
  host,
  isAdmin,
  onUpdate,
}: {
  host: HostLike;
  isAdmin: boolean;
  onUpdate: () => void;
}) {
  const dismiss = useDismissUpdate();
  const stateLabel = versionStateLabel(host);
  const progress = updateProgressText(host.update);
  const online = host.status === "online";
  return (
    <Row
      testID={`settings__host-${host.name}`}
      title={host.name}
      detail={lastSeenText(host)}
      right={
        <View style={styles.status}>
          <View
            style={[
              styles.dot,
              {
                backgroundColor: online
                  ? tones.success
                  : host.status === "lost"
                    ? tones.failure
                    : tones.neutral,
              },
            ]}
          />
          <Text style={styles.statusText} testID={`settings__host-status-${host.name}`}>
            {host.status}
          </Text>
        </View>
      }
    >
      {host.usable ? (
        <View style={styles.version}>
          <Text style={styles.detail} testID={`settings__host-version-${host.name}`}>
            {versionText(host)}
            {stateLabel ? ` · ${stateLabel}` : ""}
          </Text>
          {host.updateRequired ? (
            <Text style={styles.error} testID={`settings__host-update-required-${host.name}`}>
              {host.updateRequired}
            </Text>
          ) : null}
          {progress ? (
            <Text style={styles.detail} testID={`settings__host-update-progress-${host.name}`}>
              {progress}
            </Text>
          ) : null}
          {host.update?.state === "failed" ? (
            <Text style={styles.error} testID={`settings__host-update-error-${host.name}`}>
              {host.update.error}
            </Text>
          ) : null}
          <View style={styles.actions}>
            {showUpdateButton(host, isAdmin) ? (
              <SmallButton
                label={updateButtonLabel(host.update)}
                disabled={isUpdating(host.update)}
                onPress={onUpdate}
                testID={`settings__host-update-${host.name}`}
              />
            ) : null}
            {host.update?.state === "failed" && isAdmin ? (
              <SmallButton
                label="Dismiss"
                busy={dismiss.isPending}
                onPress={() => dismiss.mutate(host.id)}
                testID={`settings__host-dismiss-${host.name}`}
              />
            ) : null}
          </View>
          {host.updateTarget && !showUpdateButton(host, isAdmin) && host.manualCommand ? (
            <Text style={styles.command} selectable testID={`settings__host-manual-${host.name}`}>
              {host.manualCommand}
            </Text>
          ) : null}
        </View>
      ) : null}
    </Row>
  );
}

function UpdateConfirm({ host, onClose }: { host: HostLike; onClose: () => void }) {
  const interruptions = useInterruptions(host.id, true);
  const update = useUpdateHost();
  const agents = interruptions.data?.agents ?? [];
  const lines = interruptionLines(agents);
  const [error, setError] = useState<string | null>(null);

  const confirm = () => {
    setError(null);
    update.mutate(host.id, {
      onSuccess: onClose,
      onError: (err) => setError(errorText(err)),
    });
  };

  return (
    <ConfirmSheet
      visible
      testID="settings__update-confirm"
      title={`Update ${host.name} to ${host.updateTarget ?? "the latest version"}?`}
      message="The worker installs the new version and restarts. Restarting ends every agent running on this worker, and a turn in progress is lost."
      confirmLabel="Update and restart"
      busy={update.isPending}
      disabled={interruptions.isPending || interruptions.isError}
      error={error}
      onConfirm={confirm}
      onCancel={onClose}
    >
      {interruptions.isPending ? (
        <Notice testID="settings__update-agents">Checking running agents…</Notice>
      ) : interruptions.isError ? (
        <Notice tone="error" testID="settings__update-agents">
          Could not check which agents are running on this worker.
        </Notice>
      ) : lines.length === 0 ? (
        <Notice testID="settings__update-agents">No agents are running on this worker.</Notice>
      ) : (
        <View testID="settings__update-agents">
          <Text style={styles.agentsTitle}>
            {lines.length === 1 ? "1 agent" : `${lines.length} agents`} will be interrupted:
          </Text>
          {lines.map((line) => (
            <Text key={line} style={styles.detail}>
              {`• ${line}`}
            </Text>
          ))}
        </View>
      )}
    </ConfirmSheet>
  );
}

const styles = StyleSheet.create({
  status: { alignItems: "center", flexDirection: "row", gap: 6 },
  dot: { borderRadius: 4, height: 8, width: 8 },
  statusText: { color: colors.mutedForeground, fontSize: 13 },
  version: { gap: 4 },
  detail: { color: colors.mutedForeground, fontSize: 13, lineHeight: 18 },
  error: { color: colors.destructive, fontSize: 13, lineHeight: 18 },
  actions: { alignSelf: "flex-start", flexDirection: "row", gap: 8, marginTop: 2 },
  command: { color: colors.foreground, fontFamily: "Menlo", fontSize: 12 },
  agentsTitle: { color: colors.foreground, fontSize: 14, fontWeight: "600" },
});
