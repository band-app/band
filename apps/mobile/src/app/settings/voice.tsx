import { useState } from "react";
import { Switch } from "react-native";
import {
  Group,
  Loading,
  Notice,
  Row,
  SettingsScreen,
  SmallButton,
} from "../../components/settings-ui";
import { SessionGate } from "../../lib/hub-session";
import { errorText } from "../../lib/settings/errors";
import {
  testMessage,
  type VoiceConfig,
  voiceBody,
  voiceReady,
  voiceTestBody,
} from "../../lib/settings/voice";
import {
  useCurrentToken,
  useLiveHosts,
  useSaveVoice,
  useTestVoice,
  useVoiceConfig,
  useVoiceStatus,
} from "../../lib/use-settings-data";

export default function Voice() {
  return (
    <SessionGate>
      <VoiceScreen />
    </SessionGate>
  );
}

function VoiceScreen() {
  const status = useVoiceStatus();
  const current = useCurrentToken();
  const isAdmin = current.data?.admin === true;
  const config = useVoiceConfig(isAdmin);
  const hosts = useLiveHosts();
  const save = useSaveVoice();
  const test = useTestVoice();
  const [tested, setTested] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const saved = config.data as VoiceConfig | undefined;

  const toggle = (enabled: boolean) => {
    if (!saved) return;
    setError(null);
    setTested(null);
    save.mutate(voiceBody(saved, enabled), { onError: (err) => setError(errorText(err)) });
  };

  const runTest = () => {
    if (!saved) return;
    setError(null);
    setTested(null);
    test.mutate(voiceTestBody(saved), {
      onSuccess: (result) =>
        setTested(
          testMessage(result.hostId, hosts.data?.find((h) => h.id === result.hostId)?.name),
        ),
      onError: (err) => setError(errorText(err)),
    });
  };

  return (
    <SettingsScreen title="Voice" testID="settings__voice">
      <Notice>
        Dictation in the chat composer. Audio goes to the hub, which sends it to one speech-to-text
        endpoint.
      </Notice>
      {status.isPending ? <Loading testID="settings__voice-loading" /> : null}
      {status.isError ? (
        <Notice tone="error" testID="settings__voice-status-error">
          {errorText(status.error)}
        </Notice>
      ) : null}
      {status.data ? (
        <Group>
          <Row
            testID="settings__voice-status"
            title="Status"
            detail={status.data.available ? null : (status.data.reason ?? "Not set up")}
            value={status.data.available ? "Available" : "Unavailable"}
          />
        </Group>
      ) : null}
      {current.isSuccess && !isAdmin ? (
        <Notice testID="settings__voice-not-admin">Setting up voice needs an admin token.</Notice>
      ) : null}
      {isAdmin && config.isPending ? <Loading testID="settings__voice-config-loading" /> : null}
      {isAdmin && config.isError ? (
        <Notice tone="error" testID="settings__voice-config-error">
          {errorText(config.error)}
        </Notice>
      ) : null}
      {saved ? (
        <>
          <Group>
            <Row
              testID="settings__voice-endpoint"
              title="Endpoint"
              detail={
                saved.baseUrl
                  ? `${saved.baseUrl}\n${saved.model || "no model"}`
                  : "Not set. Set it in Settings on the web."
              }
            />
            <Row
              title="Voice dictation"
              detail="Show a mic in the chat composer."
              right={
                <Switch
                  value={saved.enabled}
                  disabled={save.isPending}
                  onValueChange={toggle}
                  accessibilityLabel="Voice dictation"
                  testID="settings__voice-enabled"
                />
              }
            />
          </Group>
          <SmallButton
            label={test.isPending ? "Testing" : "Test connection"}
            busy={test.isPending}
            disabled={!voiceReady(saved)}
            onPress={runTest}
            testID="settings__voice-test"
          />
          {tested ? (
            <Notice tone="ok" testID="settings__voice-ok">
              {tested}
            </Notice>
          ) : null}
          {error ? (
            <Notice tone="error" testID="settings__voice-error">
              {error}
            </Notice>
          ) : null}
        </>
      ) : null}
    </SettingsScreen>
  );
}
