import { router } from "expo-router";
import { Body, Button, Screen, Title } from "../components/ui";

export default function Connect() {
  return (
    <Screen testID="connect__screen">
      <Title>Connect to a hub</Title>
      <Body>
        In Band on your computer, open Settings &gt; Devices and choose Add device. Scan the QR code
        it shows, or type the hub URL and token.
      </Body>
      <Button label="Scan QR code" testID="connect__scan" onPress={() => router.push("/scan")} />
      <Button
        label="Enter URL and token"
        variant="secondary"
        testID="connect__manual"
        onPress={() => router.push("/manual")}
      />
    </Screen>
  );
}
