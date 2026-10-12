import { useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Body, Button, ErrorText, Field, Screen } from "../components/ui";
import { useHubs } from "../lib/hubs-context";
import { resetTo } from "../lib/navigation";
import { parseHubUrl } from "../lib/pairing";

/** Manual pairing, and editing a saved hub (`?url=` fills the URL in). */
export default function Manual() {
  const params = useLocalSearchParams<{ url?: string }>();
  const { pair } = useHubs();
  const [url, setUrl] = useState(params.url ?? "");
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
    setBusy(false);
    if (check.ok) resetTo("/home");
    else setError(check.error);
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
