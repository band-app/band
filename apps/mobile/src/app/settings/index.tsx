import { Info, Mic, Server, Smartphone, Sparkles } from "lucide-react-native";
import { Group, LinkRow, SettingsScreen } from "../../components/settings-ui";
import { SessionGate } from "../../lib/hub-session";

/** The sections people use most on a phone, in the order the web lists them. */
export default function Settings() {
  return (
    <SessionGate>
      <SettingsScreen title="Settings" testID="settings__screen">
        <Group>
          <LinkRow
            title="Workers"
            detail="Workers and their versions"
            icon={Server}
            href="/settings/hosts"
            testID="settings__open-hosts"
          />
          <LinkRow
            title="Agents"
            detail="Coding agents and models"
            icon={Sparkles}
            href="/settings/agents"
            testID="settings__open-agents"
          />
          <LinkRow
            title="Voice"
            detail="Dictation"
            icon={Mic}
            href="/settings/voice"
            testID="settings__open-voice"
          />
          <LinkRow
            title="Devices"
            detail="Phones and browsers that reach this hub"
            icon={Smartphone}
            href="/settings/devices"
            testID="settings__open-devices"
          />
          <LinkRow
            title="About"
            detail="Hub and app versions"
            icon={Info}
            href="/settings/about"
            testID="settings__open-about"
          />
        </Group>
      </SettingsScreen>
    </SessionGate>
  );
}
