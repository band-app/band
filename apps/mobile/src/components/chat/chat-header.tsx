import type { sessionPickers } from "@band-app/client/session-pickers";
import { useCallback, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "../../theme";
import { SessionSheet } from "./session-sheet";

type Pickers = ReturnType<typeof sessionPickers>;

/** The chat's model and mode, under the worktree's name. Tapping either opens the session sheet. */
export function ChatHeader({
  pickers,
  setConfigOption,
}: {
  pickers: Pickers;
  setConfigOption: (configId: string, value: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  // Changes in flight. A chat without a live session starts one before the change applies.
  const [pending, setPending] = useState(0);

  const choose = useCallback(
    (configId: string, value: string) => {
      setPending((n) => n + 1);
      setConfigOption(configId, value)
        .catch((err) =>
          Alert.alert(
            "Couldn't change the session",
            err instanceof Error ? err.message : "Try again.",
          ),
        )
        .finally(() => setPending((n) => n - 1));
    },
    [setConfigOption],
  );

  const model = pickers.models.find((m) => m.id === pickers.model)?.name ?? pickers.model;
  const mode = pickers.modes.find((m) => m.id === pickers.mode)?.name ?? pickers.mode;
  if (!model && !mode) return null;

  return (
    <View style={styles.root} testID="chat__header">
      {model ? (
        <Chip label={model} a11y="Model" onPress={() => setOpen(true)} testID="chat__model" />
      ) : null}
      {mode ? (
        <Chip label={mode} a11y="Mode" onPress={() => setOpen(true)} testID="chat__mode" />
      ) : null}
      <SessionSheet
        visible={open}
        onClose={() => setOpen(false)}
        pickers={pickers}
        pending={pending > 0}
        onChoose={choose}
      />
    </View>
  );
}

function Chip({
  label,
  a11y,
  onPress,
  testID,
}: {
  label: string;
  a11y: string;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${a11y}: ${label}`}
      onPress={onPress}
      style={styles.chip}
      testID={testID}
    >
      <Text style={styles.label} numberOfLines={1}>
        {label}
      </Text>
      <Text style={styles.caret}>▾</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: {
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  chip: {
    alignItems: "center",
    backgroundColor: colors.muted,
    borderRadius: 14,
    flexDirection: "row",
    flexShrink: 1,
    gap: 4,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  label: { color: colors.foreground, flexShrink: 1, fontSize: 13 },
  caret: { color: colors.mutedForeground, fontSize: 11 },
});
