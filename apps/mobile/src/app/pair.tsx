import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Body, Button, Centered, ErrorText, Spinner, Title } from "../components/ui";
import { useHubs } from "../lib/hubs-context";
import { resetTo } from "../lib/navigation";
import { parsePairLink } from "../lib/pairing";

/** The deep link `band://pair?url=<hub URL>&token=<token>`: the same pairing as a scan. */
export default function Pair() {
  const { url, token } = useLocalSearchParams<{ url?: string; token?: string }>();
  const { pair } = useHubs();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const parsed = parsePairLink({ url, token });
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setError(null);
    void pair(parsed.value).then((check) => {
      if (cancelled) return;
      if (check.ok) resetTo("/home");
      else setError(check.error);
    });
    return () => {
      cancelled = true;
    };
  }, [url, token, pair]);

  if (!error) {
    return (
      <Centered>
        <Spinner />
        <Body testID="pair__progress">Connecting to the hub…</Body>
      </Centered>
    );
  }
  return (
    <Centered>
      <Title>Couldn't pair</Title>
      <ErrorText testID="pair__error">{error}</ErrorText>
      <Button label="Connect another way" variant="secondary" onPress={() => resetTo("/connect")} />
      {router.canGoBack() ? (
        <Button label="Back" variant="secondary" onPress={() => router.back()} />
      ) : null}
    </Centered>
  );
}
