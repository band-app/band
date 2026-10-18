import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import { useState } from "react";
import { StyleSheet, Switch, Text, TextInput, View } from "react-native";
import {
  ConfirmSheet,
  Group,
  Loading,
  Notice,
  Row,
  SettingsScreen,
  SmallButton,
} from "../../components/settings-ui";
import { SessionGate, useHubSession } from "../../lib/hub-session";
import {
  canRevoke,
  deviceDetail,
  devicesOf,
  pairingLink,
  revokePrompt,
} from "../../lib/settings/devices";
import { errorText } from "../../lib/settings/errors";
import {
  useAddDevice,
  useCurrentToken,
  useRevokeToken,
  useTokens,
} from "../../lib/use-settings-data";
import { colors, useScheme } from "../../theme";

export default function Devices() {
  return (
    <SessionGate>
      <DevicesScreen />
    </SessionGate>
  );
}

type Token = NonNullable<ReturnType<typeof useTokens>["data"]>[number];

function DevicesScreen() {
  const current = useCurrentToken();
  const isAdmin = current.data?.admin === true;
  const tokens = useTokens(isAdmin);
  const [revoking, setRevoking] = useState<Token | null>(null);
  const [adding, setAdding] = useState(false);

  if (current.isPending) {
    return (
      <SettingsScreen title="Devices" testID="settings__devices">
        <Loading testID="settings__devices-loading" />
      </SettingsScreen>
    );
  }
  if (!isAdmin) {
    return (
      <SettingsScreen title="Devices" testID="settings__devices">
        <Notice testID="settings__devices-denied">Managing devices needs an admin token.</Notice>
      </SettingsScreen>
    );
  }
  const devices = devicesOf(tokens.data ?? []);
  return (
    <SettingsScreen title="Devices" testID="settings__devices">
      <Notice>
        Revoking a device signs it out and removes it. The shared token in settings.json cannot be
        revoked here.
      </Notice>
      <SmallButton
        label="Add device"
        onPress={() => setAdding(true)}
        testID="settings__add-device"
      />
      {tokens.isPending ? <Loading testID="settings__devices-list-loading" /> : null}
      {tokens.isError ? (
        <Notice tone="error" testID="settings__devices-error">
          {errorText(tokens.error)}
        </Notice>
      ) : null}
      {tokens.data ? (
        <Group testID="settings__device-list">
          {devices.map((device) => {
            const own = device.id === current.data?.tokenId;
            return (
              <Row
                key={device.id}
                testID={`settings__device-${device.label || device.id}`}
                title={`${device.label || device.id}${own ? " (this device)" : ""}`}
                detail={deviceDetail(device)}
                right={
                  <SmallButton
                    label="Revoke"
                    destructive
                    disabled={!canRevoke(device)}
                    onPress={() => setRevoking(device)}
                    testID={`settings__device-revoke-${device.label || device.id}`}
                  />
                }
              />
            );
          })}
        </Group>
      ) : null}
      {revoking ? (
        <RevokeConfirm
          device={revoking}
          currentTokenId={current.data?.tokenId ?? null}
          onClose={() => setRevoking(null)}
        />
      ) : null}
      {adding ? <AddDevice onClose={() => setAdding(false)} /> : null}
    </SettingsScreen>
  );
}

function RevokeConfirm({
  device,
  currentTokenId,
  onClose,
}: {
  device: Token;
  currentTokenId: string | null;
  onClose: () => void;
}) {
  const revoke = useRevokeToken();
  const prompt = revokePrompt(device, currentTokenId);
  const [error, setError] = useState<string | null>(null);
  return (
    <ConfirmSheet
      visible
      testID={prompt.own ? "settings__revoke-own-confirm" : "settings__revoke-confirm"}
      title={prompt.title}
      message={prompt.message}
      confirmLabel={prompt.confirm}
      destructive
      busy={revoke.isPending}
      error={error}
      onCancel={onClose}
      onConfirm={() => {
        setError(null);
        revoke.mutate(device.id, {
          onSuccess: () => {
            onClose();
            // The hub no longer accepts this session, so go to the hubs list.
            if (prompt.own) router.replace("/hubs");
          },
          onError: (err) => setError(errorText(err)),
        });
      }}
    />
  );
}

function AddDevice({ onClose }: { onClose: () => void }) {
  const { hub } = useHubSession();
  const scheme = useScheme();
  const add = useAddDevice();
  const [label, setLabel] = useState("Phone");
  const [admin, setAdmin] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const result = add.data;
  const link = result ? pairingLink(result.publicUrl ?? hub.url, result.code) : null;

  return (
    <ConfirmSheet
      visible
      testID="settings__add-device-sheet"
      title={result ? `Connect ${result.label}` : "Add device"}
      message={
        result
          ? "Open the link on the device. It works once and expires in 15 minutes. Opening it signs that device in."
          : "Name the device. You get a one-time pairing link next."
      }
      confirmLabel={result ? "Done" : "Create device"}
      busy={add.isPending}
      disabled={!result && label.trim() === ""}
      error={error}
      onCancel={onClose}
      onConfirm={() => {
        if (result) {
          onClose();
          return;
        }
        setError(null);
        add.mutate({ label: label.trim(), admin }, { onError: (err) => setError(errorText(err)) });
      }}
    >
      {link ? (
        <View style={styles.link}>
          <Text style={styles.linkText} selectable testID="settings__pairing-link">
            {link}
          </Text>
          <SmallButton
            label={copied ? "Copied" : "Copy link"}
            onPress={() => {
              void Clipboard.setStringAsync(link).then(() => setCopied(true));
            }}
            testID="settings__pairing-copy"
          />
        </View>
      ) : (
        <View style={styles.form}>
          <TextInput
            keyboardAppearance={scheme}
            value={label}
            onChangeText={setLabel}
            placeholder="Label"
            placeholderTextColor={colors.faint}
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
            accessibilityLabel="Device label"
            testID="settings__device-label"
          />
          <View style={styles.adminRow}>
            <Text style={styles.adminLabel}>Admin device</Text>
            <Switch
              value={admin}
              onValueChange={setAdmin}
              accessibilityLabel="Admin device"
              testID="settings__device-admin"
            />
          </View>
          {admin ? (
            <Notice tone="error">
              An admin device can create and revoke devices, workers and credentials.
            </Notice>
          ) : null}
        </View>
      )}
    </ConfirmSheet>
  );
}

const styles = StyleSheet.create({
  form: { gap: 10 },
  input: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    color: colors.foreground,
    fontSize: 16,
    minHeight: 46,
    paddingHorizontal: 12,
  },
  adminRow: { alignItems: "center", flexDirection: "row", justifyContent: "space-between" },
  adminLabel: { color: colors.foreground, fontSize: 16 },
  link: { gap: 10 },
  linkText: { color: colors.foreground, fontFamily: "Menlo", fontSize: 12 },
});
