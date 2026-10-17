import { useLocalSearchParams } from "expo-router";
import { useState } from "react";

import { Body, Button, Centered, ErrorText, Title } from "../components/ui";
import { useHubs } from "../lib/hubs-context";
import { resetTo } from "../lib/navigation";
import { parsePairLink } from "../lib/pairing";

/**
 * The deep link `band://pair?url=<hub URL>&code=<pairing code>` (or the older `&token=<token>`): the same pairing as a scan. Any
 * page or app can open the link, so the person confirms the hub before Band pairs with it
 * and makes it the active hub.
 */
export default function Pair() {
  const { url, token, code } = useLocalSearchParams<{
    url?: string;
    token?: string;
    code?: string;
  }>();
  const { pair, active } = useHubs();
  // A second link can reuse this screen with new params, so an error belongs to the link it
  // came from.
  const link = `${url ?? ""}\n${token ?? ""}\n${code ?? ""}`;
  const [failure, setFailure] = useState<{ link: string; error: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const parsed = parsePairLink({ url, token, code });
  const error = failure?.link === link ? failure.error : null;

  const leave = () => resetTo(active ? "/home" : "/connect");

  if (!parsed.ok || error) {
    return (
      <Centered>
        <Title>Couldn't pair</Title>
        <ErrorText testID="pair__error">{parsed.ok ? error : parsed.error}</ErrorText>
        <Button
          label="Connect another way"
          variant="secondary"
          onPress={() => resetTo("/connect")}
        />
        <Button label="Cancel" variant="secondary" onPress={leave} testID="pair__cancel" />
      </Centered>
    );
  }

  const connect = async () => {
    setBusy(true);
    const check = await pair(parsed.value);
    setBusy(false);
    if (check.ok) resetTo("/home");
    else setFailure({ link, error: check.error });
  };

  return (
    <Centered>
      <Title testID="pair__title">Connect to this hub?</Title>
      <Title testID="pair__host">{new URL(parsed.value.url).host}</Title>
      <Body testID="pair__url">{parsed.value.url}</Body>
      <Body>
        Only connect to a hub you run or trust. It will see the prompts and files you work on in
        Band.
      </Body>
      <Button label="Connect" busy={busy} onPress={() => void connect()} testID="pair__connect" />
      <Button label="Cancel" variant="secondary" onPress={leave} testID="pair__cancel" />
    </Centered>
  );
}
