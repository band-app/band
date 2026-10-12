import { router } from "expo-router";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { Body, Button, Screen, styles } from "../components/ui";
import type { SavedHub } from "../lib/hub-store";
import { useHubs } from "../lib/hubs-context";
import { resetTo } from "../lib/navigation";
import { colors } from "../theme";

/** Every paired hub: switch to one, remove one, or pair another. */
export default function Hubs() {
  const { list, setActive, remove } = useHubs();
  const hubs = list?.hubs ?? [];

  const failed = (err: unknown) =>
    Alert.alert(
      "Band could not update its saved hubs",
      err instanceof Error ? err.message : String(err),
    );

  const choose = async (hub: SavedHub) => {
    try {
      await setActive(hub.id);
    } catch (err) {
      failed(err);
      return;
    }
    resetTo("/home");
  };

  const confirmRemove = (hub: SavedHub) => {
    Alert.alert(`Remove ${hub.label}?`, "Band forgets this hub and its token on this phone.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () =>
          void remove(hub.id).then(() => {
            if (hubs.length <= 1) resetTo("/connect");
          }, failed),
      },
    ]);
  };

  return (
    <Screen testID="hubs__screen">
      {hubs.length === 0 ? <Body>No hubs yet.</Body> : null}
      {hubs.map((hub) => {
        const isActive = hub.id === list?.activeId;
        return (
          <View
            key={hub.id}
            style={[styles.card, isActive && hubStyles.active]}
            testID={`hubs__row-${hub.id}`}
          >
            <Pressable
              onPress={() => void choose(hub)}
              accessibilityRole="button"
              accessibilityLabel={`Use ${hub.label}`}
              testID={`hubs__use-${hub.id}`}
            >
              <Text style={hubStyles.name}>
                {hub.label}
                {isActive ? "  (active)" : ""}
              </Text>
              <Body>{hub.url}</Body>
            </Pressable>
            <Button
              label="Remove"
              variant="destructive"
              onPress={() => confirmRemove(hub)}
              testID={`hubs__remove-${hub.id}`}
            />
          </View>
        );
      })}
      <Button
        label="Add hub"
        variant="secondary"
        onPress={() => router.push("/connect")}
        testID="hubs__add"
      />
    </Screen>
  );
}

const hubStyles = StyleSheet.create({
  active: { borderColor: colors.foreground },
  name: { color: colors.foreground, fontSize: 17, fontWeight: "600" },
});
