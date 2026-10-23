import { StyleSheet, Text, View } from "react-native";
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

/**
 * The agent's state as the web sidebar draws it: a solid dot for working, done and failed, a ring
 * for monitoring, a "?" disc for a question, and a faint solid dot when the agent is idle.
 */
export function StateIcon({ state, testID }: { state: ShownState; testID?: string }) {
  return (
    <View
      style={styles.box}
      accessibilityLabel={state === "idle" ? "No agent activity" : SHOWN_LABEL[state]}
      testID={testID}
    >
      {state === "working" ? (
        <View style={[styles.dot, { backgroundColor: tones.pending }]} />
      ) : state === "monitoring" ? (
        <View style={[styles.dot, styles.ring, { borderColor: tones.pending }]} />
      ) : state === "question" ? (
        <View style={[styles.disc, { backgroundColor: tones.attention }]}>
          <Text style={styles.discText}>?</Text>
        </View>
      ) : state === "done" ? (
        <View style={[styles.dot, { backgroundColor: tones.success }]} />
      ) : state === "failed" ? (
        <View style={[styles.dot, { backgroundColor: tones.failure }]} />
      ) : (
        <View style={[styles.dot, styles.idle]} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { width: 20, height: 20, alignItems: "center", justifyContent: "center" },
  dot: { width: 9, height: 9, borderRadius: 5 },
  idle: { backgroundColor: colors.mutedForeground, opacity: 0.4 },
  ring: { backgroundColor: "transparent", borderWidth: 2 },
  disc: { width: 14, height: 14, borderRadius: 7, alignItems: "center", justifyContent: "center" },
  discText: { color: "#000", fontSize: 10, fontWeight: "800" },
});
