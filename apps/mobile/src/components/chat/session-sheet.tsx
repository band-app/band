import {
  type SelectOption,
  selectChoices,
  type sessionPickers,
} from "@band-app/client/session-pickers";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";

import { colors } from "../../theme";

type Pickers = ReturnType<typeof sessionPickers>;

/**
 * Model, mode and the other options the agent offers, in the system's page sheet. A choice is
 * applied at once through `chats.setConfigOption`, like the web's menus, and the sheet stays
 * open so several can change in one visit.
 */
export function SessionSheet({
  visible,
  onClose,
  pickers,
  pending,
  onChoose,
}: {
  visible: boolean;
  onClose: () => void;
  pickers: Pickers;
  pending: boolean;
  onChoose: (configId: string, value: string) => void;
}) {
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={styles.sheet} testID="session-sheet">
        <View style={styles.header}>
          <Text style={styles.title} accessibilityRole="header">
            Session
          </Text>
          {pending ? (
            <ActivityIndicator
              size="small"
              color={colors.mutedForeground}
              testID="session-sheet__pending"
            />
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Done"
            onPress={onClose}
            hitSlop={8}
            testID="session-sheet__done"
          >
            <Text style={styles.done}>Done</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.body}>
          {pickers.models.length > 0 ? (
            <Section title="Model" testID="session-sheet__models">
              {pickers.models.map((m) => (
                <Choice
                  key={m.id}
                  name={m.name}
                  description={m.description}
                  selected={m.id === pickers.model}
                  onPress={() => onChoose(pickers.modelConfigId, m.id)}
                  testID={`session-sheet__model-${m.id}`}
                />
              ))}
            </Section>
          ) : null}
          {pickers.modes.length > 0 ? (
            <Section title="Mode" testID="session-sheet__modes">
              {pickers.modes.map((m) => (
                <Choice
                  key={m.id}
                  name={m.name}
                  description={m.description}
                  selected={m.id === pickers.mode}
                  onPress={() => onChoose(pickers.modeConfigId, m.id)}
                  testID={`session-sheet__mode-${m.id}`}
                />
              ))}
            </Section>
          ) : null}
          {pickers.effort ? <OptionSection option={pickers.effort} onChoose={onChoose} /> : null}
          {pickers.fast ? (
            <View style={styles.switchRow}>
              <Text style={styles.name}>{pickers.fast.name}</Text>
              <Switch
                value={pickers.fast.currentValue === "on"}
                onValueChange={(on) => onChoose(pickers.fast?.id ?? "fast", on ? "on" : "off")}
                accessibilityLabel={pickers.fast.name}
                testID="session-sheet__fast"
              />
            </View>
          ) : null}
          {pickers.others.map((option) => (
            <OptionSection key={option.id} option={option} onChoose={onChoose} />
          ))}
        </ScrollView>
      </View>
    </Modal>
  );
}

function OptionSection({
  option,
  onChoose,
}: {
  option: SelectOption;
  onChoose: (configId: string, value: string) => void;
}) {
  return (
    <Section title={option.name} testID={`session-sheet__option-${option.id}`}>
      {selectChoices(option).map((c) => (
        <Choice
          key={c.id}
          name={c.name}
          description={c.description}
          selected={c.id === option.currentValue}
          onPress={() => onChoose(option.id, c.id)}
          testID={`session-sheet__option-${option.id}-${c.id}`}
        />
      ))}
    </Section>
  );
}

function Section({
  title,
  testID,
  children,
}: {
  title: string;
  testID: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section} testID={testID}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.card}>{children}</View>
    </View>
  );
}

function Choice({
  name,
  description,
  selected,
  onPress,
  testID,
}: {
  name: string;
  description?: string;
  selected: boolean;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={name}
      accessibilityState={{ selected }}
      onPress={onPress}
      style={styles.choice}
      testID={testID}
    >
      <View style={styles.choiceText}>
        <Text style={styles.name}>{name}</Text>
        {description ? (
          <Text style={styles.description} numberOfLines={2}>
            {description}
          </Text>
        ) : null}
      </View>
      {selected ? <Text style={styles.check}>✓</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  sheet: { backgroundColor: colors.background, flex: 1 },
  header: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  title: { color: colors.foreground, flex: 1, fontSize: 17, fontWeight: "600" },
  done: { color: colors.foreground, fontSize: 16, fontWeight: "600" },
  body: { gap: 16, padding: 16, paddingBottom: 40 },
  section: { gap: 6 },
  sectionTitle: { color: colors.mutedForeground, fontSize: 13, textTransform: "uppercase" },
  card: { backgroundColor: colors.card, borderRadius: 10, overflow: "hidden" },
  choice: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  choiceText: { flex: 1, gap: 2 },
  name: { color: colors.foreground, fontSize: 16 },
  description: { color: colors.mutedForeground, fontSize: 13 },
  check: { color: colors.foreground, fontSize: 17 },
  switchRow: { alignItems: "center", flexDirection: "row", justifyContent: "space-between" },
});
