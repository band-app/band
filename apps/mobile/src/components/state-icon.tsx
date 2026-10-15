import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import type { ShownState } from "../lib/status-state";
import { colors, tones } from "../theme";

export const SHOWN_LABEL: Record<ShownState, string> = {
  working: "working",
  monitoring: "monitoring",
  question: "needs you",
  done: "finished",
  failed: "failed",
  idle: "idle",
};

/** The agent's state as the design draws it: spinner, ? disc, check ring, x disc, dashed ring, dot. */
export function StateIcon({ state, testID }: { state: ShownState; testID?: string }) {
  return (
    <View style={styles.box} accessibilityLabel={SHOWN_LABEL[state]} testID={testID}>
      {state === "working" ? (
        <ActivityIndicator size="small" color={tones.running} style={styles.spinner} />
      ) : state === "question" ? (
        <View style={[styles.disc, { backgroundColor: tones.attention }]}>
          <Text style={styles.discText}>?</Text>
        </View>
      ) : state === "done" ? (
        <View style={[styles.ring, { borderColor: tones.success }]}>
          <Text style={[styles.check, { color: tones.success }]}>✓</Text>
        </View>
      ) : state === "failed" ? (
        <View style={[styles.disc, { backgroundColor: tones.failure }]}>
          <Text style={styles.discText}>✕</Text>
        </View>
      ) : state === "monitoring" ? (
        <View
          style={[
            styles.ring,
            { borderColor: tones.merged, borderStyle: "dashed", borderWidth: 2 },
          ]}
        />
      ) : (
        <View style={styles.idle} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { width: 20, height: 20, alignItems: "center", justifyContent: "center" },
  spinner: { transform: [{ scale: 0.7 }] },
  disc: { width: 18, height: 18, borderRadius: 9, alignItems: "center", justifyContent: "center" },
  discText: { color: "#fff", fontSize: 11, fontWeight: "800" },
  ring: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 1.6,
    alignItems: "center",
    justifyContent: "center",
  },
  check: { fontSize: 10, fontWeight: "800", marginTop: -1 },
  idle: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.grab },
});
