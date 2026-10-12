import { CameraView, useCameraPermissions } from "expo-camera";
import { useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Body, Button, Centered, ErrorText, Spinner } from "../components/ui";
import { useHubs } from "../lib/hubs-context";
import { resetTo } from "../lib/navigation";
import { parseSignInUrl } from "../lib/pairing";

/** Scans the QR code from Settings > Devices, `<hubPublicUrl>/?token=bdt_…`. */
export default function Scan() {
  const [permission, requestPermission] = useCameraPermissions();
  const { pair } = useHubs();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The camera reports the same code many times a second; handle one at a time, and don't
  // retry a code that already failed until the camera sees a different one.
  const handling = useRef(false);
  const lastFailed = useRef<string | null>(null);

  if (!permission) {
    return (
      <Centered>
        <Spinner />
      </Centered>
    );
  }
  if (!permission.granted) {
    return (
      <Centered>
        <Body>Band needs the camera to scan the QR code from Settings &gt; Devices.</Body>
        <Button
          label="Allow camera"
          onPress={() => void requestPermission()}
          testID="scan__allow"
        />
      </Centered>
    );
  }

  const onScanned = async ({ data }: { data: string }) => {
    if (handling.current || data === lastFailed.current) return;
    handling.current = true;
    const parsed = parseSignInUrl(data);
    if (!parsed.ok) {
      setError(parsed.error);
      lastFailed.current = data;
      handling.current = false;
      return;
    }
    setBusy(true);
    const check = await pair(parsed.value);
    setBusy(false);
    if (check.ok) {
      resetTo("/home");
      return;
    }
    setError(check.error);
    lastFailed.current = data;
    handling.current = false;
  };

  return (
    <View style={scanStyles.root}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={busy ? undefined : onScanned}
      />
      <View style={scanStyles.footer}>
        {busy ? (
          <Spinner />
        ) : (
          <Body>Point the camera at the QR code in Settings &gt; Devices.</Body>
        )}
        {error ? <ErrorText testID="scan__error">{error}</ErrorText> : null}
        {error ? (
          <Button
            label="Try again"
            variant="secondary"
            onPress={() => {
              lastFailed.current = null;
              setError(null);
            }}
            testID="scan__retry"
          />
        ) : null}
      </View>
    </View>
  );
}

const scanStyles = StyleSheet.create({
  root: { flex: 1 },
  footer: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    padding: 20,
    paddingBottom: 40,
    gap: 8,
    backgroundColor: "rgba(0,0,0,0.7)",
  },
});
