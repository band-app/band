import type { sessionPickers } from "@band-app/client/session-pickers";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Animated,
  Dimensions,
  Modal,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { colors } from "../../theme";

type Pickers = ReturnType<typeof sessionPickers>;

const CLOSE_DISTANCE = 60;
const CLOSE_VELOCITY = 0.8;

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
  const height = Dimensions.get("window").height;
  const offset = useRef(new Animated.Value(height)).current;
  const [shown, setShown] = useState(visible);

  const slideTo = useCallback(
    (to: number, done?: () => void) => {
      Animated.timing(offset, { toValue: to, duration: 220, useNativeDriver: true }).start(done);
    },
    [offset],
  );

  // Depends on `visible` only, so mounting the modal does not restart the slide-in.
  useEffect(() => {
    if (visible) {
      setShown(true);
      offset.setValue(height);
      slideTo(0);
    } else {
      slideTo(height, () => setShown(false));
    }
  }, [visible, height, offset, slideTo]);

  const pan = useRef(
    PanResponder.create({
      // Capture, so a drag that starts on a row or button still moves the drawer.
      onMoveShouldSetPanResponderCapture: (_e, g) => g.dy > 6 && Math.abs(g.dy) > Math.abs(g.dx),
      onPanResponderMove: (_e, g) => offset.setValue(Math.max(0, g.dy)),
      onPanResponderRelease: (_e, g) => {
        if (g.dy > CLOSE_DISTANCE || g.vy > CLOSE_VELOCITY) onClose();
        else slideTo(0);
      },
      // The system took the gesture (a call, a notification): settle back instead of staying half open.
      onPanResponderTerminate: () => slideTo(0),
    }),
  ).current;

  return (
    <Modal
      visible={shown}
      transparent
      animationType="none"
      onRequestClose={onClose}
      onDismiss={onDismissed}
    >
      <View style={styles.root}>
        <Pressable
          style={styles.backdrop}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel="Close"
          testID="plus-drawer__backdrop"
        />
        <Animated.View
          style={[styles.sheet, { transform: [{ translateY: offset }] }]}
          accessibilityViewIsModal
          accessibilityLabel="Attach and mode"
          testID="plus-drawer"
          {...pan.panHandlers}
        >
          <View style={styles.grab} />
          <View style={styles.actions}>
            <Action
              label="Photo library"
              glyph="🖼"
              onPress={onPhotos}
              testID="plus-drawer__photos"
            />
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
        </Animated.View>
      </View>
    </Modal>
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
  root: { flex: 1, justifyContent: "flex-end" },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: colors.scrim },
  sheet: {
    backgroundColor: colors.background,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    gap: 16,
    paddingBottom: 36,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  grab: {
    alignSelf: "center",
    backgroundColor: colors.grab,
    borderRadius: 3,
    height: 5,
    width: 38,
  },
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
