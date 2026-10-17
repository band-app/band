import type { sessionPickers } from "@band-app/client/session-pickers";
import {
  Camera,
  Check,
  ClipboardList,
  File,
  Hand,
  Image,
  type LucideIcon,
  PencilLine,
  ShieldAlert,
  Zap,
} from "lucide-react-native";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "../../theme";
import { BottomSheet } from "../bottom-sheet";
import { Icon } from "../icon";

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
        <Action
          label="Photo library"
          icon={Image}
          onPress={onPhotos}
          testID="plus-drawer__photos"
        />
        <Action label="Take photo" icon={Camera} onPress={onCamera} testID="plus-drawer__camera" />
        <Action label="Choose file" icon={File} onPress={onFiles} testID="plus-drawer__files" />
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
                  <Icon icon={modeIcon(m.id, m.name)} />
                  <Text style={styles.name}>{m.name}</Text>
                  {selected ? <Icon icon={Check} /> : null}
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : null}
    </BottomSheet>
  );
}

/** The web's mode menu has no icons, so these are picked by what the mode does. */
function modeIcon(id: string, name: string): LucideIcon {
  const text = `${id} ${name}`;
  if (/bypass/i.test(text)) return ShieldAlert;
  if (/plan/i.test(text)) return ClipboardList;
  if (/accept|edit/i.test(text)) return PencilLine;
  if (/auto/i.test(text)) return Zap;
  return Hand;
}

function Action({
  label,
  icon,
  onPress,
  testID,
}: {
  label: string;
  icon: LucideIcon;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={styles.action}
      testID={testID}
    >
      <Icon icon={icon} size="lg" />
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
  actionLabel: { color: colors.foreground, fontSize: 13 },
  section: { gap: 6 },
  sectionTitle: { color: colors.mutedForeground, fontSize: 13, textTransform: "uppercase" },
  card: { backgroundColor: colors.card, borderRadius: 10, overflow: "hidden" },
  choice: {
    alignItems: "center",
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  name: { color: colors.foreground, flex: 1, fontSize: 16 },
});
