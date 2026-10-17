import type { sessionPickers } from "@band-app/client/session-pickers";
import { useCallback, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useConfigChoice } from "../../lib/composer/use-config-choice";
import { colors } from "../../theme";
import { SessionHistorySheet } from "./session-history-sheet";
import { SessionSheet } from "./session-sheet";

type Pickers = ReturnType<typeof sessionPickers>;

/** What the History button needs to list and switch the chat's sessions. */
export interface SessionsControl {
  worktreeId: string;
  chatId: string;
  currentSessionId: string | undefined;
  onSwitch: (sessionId: string | undefined, summary?: string) => Promise<void>;
}

/** The chat's model as a pill in the expanded composer. Tapping it opens the session sheet. */
export function ChatHeader({
  pickers,
  setConfigOption,
  sessions,
  onOpenChange,
}: {
  pickers: Pickers;
  sessions?: SessionsControl;
  setConfigOption: (configId: string, value: string) => Promise<void>;
  /** Tells the composer a sheet is open, so it stays expanded while the input loses focus. */
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpenState] = useState(false);
  const setOpen = useCallback(
    (next: boolean) => {
      setOpenState(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );
  const [historyOpen, setHistoryOpenState] = useState(false);
  const setHistoryOpen = useCallback(
    (next: boolean) => {
      setHistoryOpenState(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );
  const { choose, pending } = useConfigChoice(setConfigOption);

  const model = pickers.models.find((m) => m.id === pickers.model)?.name ?? pickers.model;
  if (!model && !sessions) return null;

  return (
    <View style={styles.root} testID="chat__header">
      {model ? (
        <Chip label={model} a11y="Model" onPress={() => setOpen(true)} testID="chat__model" />
      ) : null}
      {sessions ? (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Session history"
            onPress={() => setHistoryOpen(true)}
            style={styles.iconButton}
            testID="chat__history"
          >
            <Text style={styles.label}>⏱</Text>
          </Pressable>
          <SessionHistorySheet
            visible={historyOpen}
            onClose={() => setHistoryOpen(false)}
            {...sessions}
          />
        </>
      ) : null}
      <SessionSheet
        visible={open}
        onClose={() => setOpen(false)}
        pickers={pickers}
        pending={pending}
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
  root: { alignItems: "center", flexDirection: "row", flexShrink: 1, gap: 6 },
  chip: {
    alignItems: "center",
    backgroundColor: colors.muted,
    borderRadius: 18,
    flexDirection: "row",
    flexShrink: 1,
    gap: 5,
    height: 36,
    paddingHorizontal: 12,
  },
  iconButton: {
    alignItems: "center",
    backgroundColor: colors.muted,
    borderRadius: 18,
    height: 36,
    justifyContent: "center",
    width: 36,
  },
  label: { color: colors.foreground, flexShrink: 1, fontSize: 14 },
  caret: { color: colors.mutedForeground, fontSize: 11 },
});
