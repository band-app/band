import { Redirect } from "expo-router";
import { Body, Centered, ErrorText, Spinner } from "../components/ui";
import { useHubs } from "../lib/hubs-context";

/** Where the app starts: the pairing screen with no hub saved, otherwise the active hub. */
export default function Index() {
  const { list, loadError, active } = useHubs();
  if (loadError) {
    return (
      <Centered>
        <Body>Band could not read its saved hubs from the Keychain.</Body>
        <ErrorText testID="index__error">{loadError}</ErrorText>
      </Centered>
    );
  }
  if (!list) {
    return (
      <Centered>
        <Spinner />
      </Centered>
    );
  }
  return <Redirect href={active ? "/home" : "/connect"} />;
}
