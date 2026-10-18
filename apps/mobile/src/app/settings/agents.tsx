import { StyleSheet, Text, View } from "react-native";
import {
  Group,
  GroupTitle,
  Loading,
  Notice,
  Row,
  SettingsScreen,
  SmallButton,
} from "../../components/settings-ui";
import { SessionGate } from "../../lib/hub-session";
import {
  type AgentAvailabilityLike,
  type AgentEntryLike,
  availabilityFor,
  availabilityText,
  modelSummary,
  refreshSummary,
} from "../../lib/settings/agents";
import { errorText } from "../../lib/settings/errors";
import { useAgentModels, useAvailability, useRefreshModels } from "../../lib/use-settings-data";
import { colors } from "../../theme";

export default function Agents() {
  return (
    <SessionGate>
      <AgentsScreen />
    </SessionGate>
  );
}

function AgentsScreen() {
  const models = useAgentModels();
  const availability = useAvailability();
  const refresh = useRefreshModels();
  const agents = (models.data?.agents ?? []) as AgentEntryLike[];
  const defaultId = models.data?.defaultAgentId ?? "";
  const hostCount = availability.data?.hosts.length ?? 0;

  return (
    <SettingsScreen title="Agents" testID="settings__agents">
      <Notice>The coding agents configured on this hub and where each can start.</Notice>
      {models.isPending ? <Loading testID="settings__agents-loading" /> : null}
      {models.isError ? (
        <Notice tone="error" testID="settings__agents-error">
          {errorText(models.error)}
        </Notice>
      ) : null}
      {models.data && agents.length === 0 ? (
        <Notice testID="settings__agents-empty">No coding agents are configured.</Notice>
      ) : null}
      {agents.length > 0 ? (
        <Group testID="settings__agent-list">
          {agents.map((agent) => {
            const hosts = availabilityFor(
              availability.data?.agents as AgentAvailabilityLike[] | undefined,
              agent.agentId,
            );
            return (
              <Row
                key={agent.agentId}
                testID={`settings__agent-${agent.agentId}`}
                title={agent.agentLabel}
                detail={modelSummary(agent)}
                value={agent.agentId === defaultId ? "Default" : null}
              >
                {hosts.map((h) => (
                  <Text
                    key={h.hostId}
                    style={[styles.host, !h.available && { color: colors.warning }]}
                    testID={`settings__agent-${agent.agentId}-host-${h.hostId}`}
                  >
                    {availabilityText(h)}
                  </Text>
                ))}
              </Row>
            );
          })}
        </Group>
      ) : null}
      {agents.length > 0 ? (
        <>
          <GroupTitle>Models</GroupTitle>
          <View style={styles.refresh}>
            <SmallButton
              label="Refresh models"
              busy={refresh.isPending}
              onPress={() => refresh.mutate(availability.data?.defaultHostId)}
              testID="settings__refresh-models"
            />
            <Text style={styles.detail}>
              {hostCount === 1 ? "Runs on 1 host" : `Runs on the default of ${hostCount} hosts`}
            </Text>
          </View>
          {refresh.isSuccess ? (
            <Notice
              testID="settings__refresh-result"
              tone={refresh.data.results.some((r) => r.error) ? "error" : "ok"}
            >
              {refreshSummary(refresh.data.results)}
            </Notice>
          ) : null}
          {refresh.isError ? (
            <Notice tone="error" testID="settings__refresh-error">
              {errorText(refresh.error)}
            </Notice>
          ) : null}
        </>
      ) : null}
    </SettingsScreen>
  );
}

const styles = StyleSheet.create({
  host: { color: colors.mutedForeground, fontSize: 13 },
  detail: { color: colors.mutedForeground, fontSize: 13 },
  refresh: { alignItems: "center", flexDirection: "row", gap: 12, marginLeft: 4 },
});
