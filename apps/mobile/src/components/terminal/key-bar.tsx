import * as Haptics from "expo-haptics";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { BAR_KEYS, type BarKey } from "../../lib/terminal/key-bar";
import { terminalColors } from "../../theme";

/** Esc, Tab, Ctrl, arrows and a few symbols the iOS keyboard buries, above the keyboard. */
export function KeyBar({
  ctrl,
  onToggleCtrl,
  onKey,
  onKeyboard,
  status,
  keyboardUp,
}: {
  ctrl: boolean;
  onToggleCtrl: () => void;
  onKey: (key: BarKey) => void;
  onKeyboard: () => void;
  status: "connecting" | "open" | "reconnecting" | "ended";
  /** The keyboard is up, so the home-indicator inset is covered. */
  keyboardUp: boolean;
}) {
  const insets = useSafeAreaInsets();
  const tap = (fn: () => void) => () => {
    void Haptics.selectionAsync().catch(() => {});
    fn();
  };
  return (
    <View
      style={[styles.bar, { paddingBottom: keyboardUp ? 6 : Math.max(insets.bottom, 6) }]}
      testID="terminal__keybar"
    >
      <ScrollView
        horizontal
        keyboardShouldPersistTaps="always"
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Show keyboard"
          onPress={tap(onKeyboard)}
          style={styles.key}
          testID="terminal__key-keyboard"
        >
          <Text style={styles.label}>⌨</Text>
        </Pressable>
        <Pressable
          accessibilityRole="togglebutton"
          accessibilityState={{ selected: ctrl }}
          accessibilityLabel="Control"
          onPress={tap(onToggleCtrl)}
          style={[styles.key, ctrl && styles.keyOn]}
          testID="terminal__key-ctrl"
        >
          <Text style={[styles.label, ctrl && styles.labelOn]}>ctrl</Text>
        </Pressable>
        {BAR_KEYS.map((k) => (
          <Pressable
            key={k.key}
            accessibilityRole="button"
            accessibilityLabel={k.key}
            onPress={tap(() => onKey(k.key))}
            style={styles.key}
            testID={`terminal__key-${k.key}`}
          >
            <Text style={styles.label}>{k.label}</Text>
          </Pressable>
        ))}
      </ScrollView>
      {status === "reconnecting" || status === "ended" ? (
        <Text style={styles.status} testID="terminal__status">
          {status === "ended" ? "ended" : "reconnecting"}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    alignItems: "center",
    backgroundColor: terminalColors.bar,
    flexDirection: "row",
    paddingTop: 6,
  },
  row: { gap: 6, paddingHorizontal: 8 },
  key: {
    alignItems: "center",
    backgroundColor: terminalColors.key,
    borderRadius: 8,
    height: 36,
    justifyContent: "center",
    minWidth: 40,
    paddingHorizontal: 8,
  },
  keyOn: { backgroundColor: terminalColors.keyOn },
  label: { color: terminalColors.keyLabel, fontSize: 15, fontWeight: "500" },
  labelOn: { color: terminalColors.keyOnLabel },
  status: { color: terminalColors.status, fontSize: 11, paddingRight: 10 },
});
