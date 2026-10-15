import { useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Body, Button, ErrorText, Field, Screen } from "../components/ui";
import { hubIdFor } from "../lib/hub-store";
import { useHubs } from "../lib/hubs-context";
import { resetTo } from "../lib/navigation";
import { parseHubUrl } from "../lib/pairing";

/**
 * Manual pairing, and editing a saved hub: `?replaces=<hub id>&url=<its URL>` fills the URL in
 * and forgets that hub once the edited one pairs under another URL.
 */
export default function Manual() {
  const params = useLocalSearchParams<{ url?: string; replaces?: string }>();
  const { list, pair, remove } = useHubs();
  // Any app can open this route as a link, so take the params only when they name a saved hub.
  const editing = list?.hubs.find((h) => h.id === params.replaces && h.url === params.url);
  const [url, setUrl] = useState(editing?.url ?? "");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const connect = async () => {
    setError(null);
    const parsed = parseHubUrl(url);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    if (!token.trim()) {
      setError("Enter the token from Settings > Devices");
      return;
    }
    setBusy(true);
    const check = await pair({ url: parsed.value, token: token.trim() });
    if (!check.ok) {
      setBusy(false);
      setError(check.error);
      return;
    }
    if (editing && editing.id !== hubIdFor(parsed.value)) {
      // The edited hub is saved and active; a failure to forget the old one leaves it listed.
      await remove(editing.id).catch(() => {});
    }
    setBusy(false);
    resetTo("/home");
  };

  return (
    <Screen testID="manual__screen">
      <Body>The URL and token are in Settings &gt; Devices &gt; Add device.</Body>
      <Field
        label="Hub URL"
        value={url}
        onChangeText={setUrl}
        placeholder="https://hub.example.com"
        keyboardType="url"
        autoComplete="off"
        testID="manual__url"
      />
      <Field
        label="Token"
        value={token}
        onChangeText={setToken}
        placeholder="bdt_…"
        // Plain, not secureTextEntry: iOS offers to save any secure field's value to the
        // user's passwords, and the token belongs only in Band's own Keychain item.
        textContentType="none"
        autoComplete="off"
        testID="manual__token"
      />
      {error ? <ErrorText testID="manual__error">{error}</ErrorText> : null}
      <Button label="Connect" busy={busy} onPress={connect} testID="manual__connect" />
    </Screen>
  );
}
