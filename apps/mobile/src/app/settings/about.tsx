import Constants from "expo-constants";
import { router } from "expo-router";
import { Group, Notice, Row, SettingsScreen, SmallButton } from "../../components/settings-ui";
import { SessionGate } from "../../lib/hub-session";
import { useHubs } from "../../lib/hubs-context";
import { errorText } from "../../lib/settings/errors";
import { useUpdateStatus } from "../../lib/use-settings-data";

export default function About() {
  return (
    <SessionGate>
      <AboutScreen />
    </SessionGate>
  );
}

function AboutScreen() {
  const { active } = useHubs();
  const status = useUpdateStatus();
  const appVersion = Constants.expoConfig?.version ?? "unknown";
  const data = status.data;
  return (
    <SettingsScreen title="About" testID="settings__about">
      <Group>
        <Row testID="settings__about-hub-url" title="Hub" detail={active?.url} />
        <Row
          testID="settings__about-hub-version"
          title="Hub version"
          value={data?.hubVersion ?? (status.isError ? "unknown" : "…")}
        />
        {data ? (
          <Row
            testID="settings__about-update"
            title={data.updateAvailable ? "Update available" : "Up to date"}
            detail={
              data.updateAvailable
                ? `${data.latest} is out.${data.hubCommand ? `\n${data.hubCommand}` : ""}`
                : data.checkEnabled
                  ? null
                  : "Release checks are turned off on this hub."
            }
          />
        ) : null}
        <Row testID="settings__about-app-version" title="App version" value={appVersion} />
      </Group>
      {status.isError ? (
        <Notice tone="error" testID="settings__about-error">
          {errorText(status.error)}
        </Notice>
      ) : null}
      <SmallButton
        label="Switch or sign out"
        onPress={() => router.push("/hubs")}
        testID="settings__about-hubs"
      />
    </SettingsScreen>
  );
}
