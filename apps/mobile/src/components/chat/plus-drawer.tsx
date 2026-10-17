import type { sessionPickers } from "@band-app/client/session-pickers";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "../../theme";
import { BottomSheet } from "../bottom-sheet";

type Pickers = ReturnType<typeof sessionPickers>;

/**
 * The composer's + drawer: a sheet that slides up over the chat with the attachment actions and
 * the agent's mode. Swiping down, tapping outside or picking an attachment action closes it.
 * Picking a mode applies it at once and keeps the drawer open.
 */
export function PlusDrawer({
  visible,
  onClose,
  onDismissed,
  onPhotos,
  onCamera,
  onFiles,
  canPaste,
  onPaste,
  pickers,
  onChooseMode,
}: {
  visible: boolean;
  onClose: () => void;
  /** Called once the modal is fully gone, so a system picker can open without clashing with it. */
  onDismissed?: () => void;
  onPhotos: () => void;
  onCamera: () => void;
  onFiles: () => void;
  /** The clipboard holds an image. Reading it waits for the tap on Paste image. */
  canPaste: boolean;
  onPaste: () => void;
  pickers: Pickers;
  onChooseMode: (configId: string, value: string) => void;
}) {
  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      onDismiss={onDismissed}
      style={styles.sheet}
      testID="plus-drawer"
      backdropTestID="plus-drawer__backdrop"
      accessibilityLabel="Attach and mode"
    >
      <View style={styles.actions}>
        <Action label="Photo library" glyph="🖼" onPress={onPhotos} testID="plus-drawer__photos" />
        <Action label="Take photo" glyph="📷" onPress={onCamera} testID="plus-drawer__camera" />
        <Action label="Choose file" glyph="📄" onPress={onFiles} testID="plus-drawer__files" />
        <Action
          label="Paste image"
          glyph="📋"
          onPress={onPaste}
          disabled={!canPaste}
          testID="plus-drawer__paste"
        />
      </View>
      {pickers.modes.length > 0 ? (
        <View style={styles.section} testID="plus-drawer__modes">
          <Text style={styles.sectionTitle} accessibilityRole="header">
            Mode
          </Text>
          <View style={styles.card}>
            {pickers.modes.map((m) => {
              const selected = m.id === pickers.mode;
              return (
                <Pressable
                  key={m.id}
                  accessibilityRole="button"
                  accessibilityLabel={m.name}
                  accessibilityState={{ selected }}
                  onPress={() => onChooseMode(pickers.modeConfigId, m.id)}
                  style={styles.choice}
                  testID={`plus-drawer__mode-${m.id}`}
                >
                  <Text style={styles.name}>{m.name}</Text>
                  {selected ? <Text style={styles.check}>✓</Text> : null}
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : null}
    </BottomSheet>
  );
}

function Action({
  label,
  glyph,
  onPress,
  disabled,
  testID,
}: {
  label: string;
  glyph: string;
  onPress: () => void;
  disabled?: boolean;
  testID: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.action, disabled && styles.actionDisabled]}
      testID={testID}
    >
      <Text style={styles.glyph}>{glyph}</Text>
      <Text style={styles.actionLabel} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  sheet: { borderTopLeftRadius: 24, borderTopRightRadius: 24, gap: 16, paddingBottom: 36 },
  actions: { flexDirection: "row", gap: 10 },
  action: {
    alignItems: "center",
    backgroundColor: colors.card,
    borderRadius: 14,
    flex: 1,
    gap: 6,
    paddingVertical: 16,
  },
  actionDisabled: { opacity: 0.4 },
  glyph: { fontSize: 26 },
  actionLabel: { color: colors.foreground, fontSize: 13 },
  section: { gap: 6 },
  sectionTitle: { color: colors.mutedForeground, fontSize: 13, textTransform: "uppercase" },
  card: { backgroundColor: colors.card, borderRadius: 10, overflow: "hidden" },
  choice: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  name: { color: colors.foreground, fontSize: 16 },
  check: { color: colors.foreground, fontSize: 17 },
});
