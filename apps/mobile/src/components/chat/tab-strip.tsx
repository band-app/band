import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { AgentChoice, ChatTab } from "../../lib/chat/use-worktree-tabs";
import type { TabState } from "../../lib/chat/worktree-tabs";
import { colors, tones } from "../../theme";

const STATE_LABEL: Record<TabState, string | null> = {
  running: "running",
  attention: "needs attention",
  unread: "new output",
  idle: null,
};

/** The colored dot of a tab's agent state; nothing when idle. */
function StateDot({ id, state }: { id: string; state: TabState }) {
  if (state === "idle") return null;
  const color =
    state === "attention"
      ? tones.attention
      : state === "running"
        ? tones.running
        : colors.foreground;
  return (
    <View
      style={[styles.dot, { backgroundColor: color }]}
      testID={`tabs__dot-${id}-${state}`}
      accessibilityLabel={STATE_LABEL[state] ?? undefined}
    />
  );
}

export interface TabActions {
  select: (id: string) => void;
  close: (id: string) => Promise<void>;
  move: (id: string, delta: number) => void;
  rename: (id: string, name: string) => Promise<void>;
  create: (agentId: string | undefined) => Promise<void>;
}

function closeTab(actions: TabActions, id: string) {
  actions.close(id).catch(() => Alert.alert("Couldn't close the chat"));
}

/** Rename, move and close for one tab, in the system's action sheet. */
function showTabMenu(tab: ChatTab, index: number, count: number, actions: TabActions) {
  const options = ["Rename", "Move left", "Move right", "Close tab", "Cancel"];
  ActionSheetIOS.showActionSheetWithOptions(
    {
      title: tab.label,
      options,
      destructiveButtonIndex: 3,
      cancelButtonIndex: 4,
      disabledButtonIndices: [...(index === 0 ? [1] : []), ...(index === count - 1 ? [2] : [])],
    },
    (choice) => {
      if (choice === 0) {
        Alert.prompt(
          "Rename tab",
          undefined,
          (name) => {
            actions.rename(tab.id, name).catch(() => Alert.alert("Couldn't rename the chat"));
          },
          "plain-text",
          tab.label,
        );
      } else if (choice === 1) actions.move(tab.id, -1);
      else if (choice === 2) actions.move(tab.id, 1);
      else if (choice === 3) closeTab(actions, tab.id);
    },
  );
}

/**
 * The worktree's chat tabs under its header: one scrollable row with the shown tab underlined, a
 * button that lists every tab in a sheet, and "+" for a new chat. A long press on a tab offers
 * rename, move and close.
 */
export function TabStrip({
  tabs,
  active,
  hidden,
  agents,
  actions,
}: {
  tabs: ChatTab[];
  active: string | null;
  hidden: number;
  agents: AgentChoice[];
  actions: TabActions;
}) {
  const scroll = useRef<ScrollView>(null);
  const offsets = useRef(new Map<string, { x: number; width: number }>());
  const [switcher, setSwitcher] = useState(false);
  const [picker, setPicker] = useState(false);

  // Keep the shown tab in view when it changes (from the sheet, or a new chat at the end). Its
  // `onLayout` scrolls again once it is laid out for a new set or order of tabs (on open, or after
  // a close or a move shifted it), but not when only a label or a state dot changed its width.
  const idsKey = tabs.map((t) => t.id).join(",");
  const laidOutFor = useRef<string | null>(null);
  const reveal = useCallback((id: string, animated: boolean) => {
    const at = offsets.current.get(id);
    if (at) scroll.current?.scrollTo({ x: Math.max(0, at.x - 24), animated });
  }, []);
  useEffect(() => {
    if (active) reveal(active, true);
  }, [active, reveal]);
  useEffect(() => {
    const ids = new Set(tabs.map((t) => t.id));
    for (const id of offsets.current.keys()) if (!ids.has(id)) offsets.current.delete(id);
  }, [tabs]);

  return (
    <View style={styles.bar} testID="tabs__strip">
      <ScrollView
        ref={scroll}
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.row}
        style={styles.scroll}
      >
        {tabs.map((tab, i) => {
          const selected = tab.id === active;
          const stateLabel = STATE_LABEL[tab.state];
          return (
            <Pressable
              key={tab.id}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              accessibilityLabel={stateLabel ? `${tab.label}, ${stateLabel}` : tab.label}
              onPress={() => actions.select(tab.id)}
              onLongPress={() => showTabMenu(tab, i, tabs.length, actions)}
              onLayout={(e) => {
                const { x, width } = e.nativeEvent.layout;
                offsets.current.set(tab.id, { x, width });
                const layoutKey = `${tab.id}|${idsKey}`;
                if (selected && laidOutFor.current !== layoutKey) {
                  laidOutFor.current = layoutKey;
                  reveal(tab.id, false);
                }
              }}
              style={[styles.tab, selected && styles.tabSelected]}
              testID={`tabs__tab-${tab.id}`}
            >
              <Text
                style={[styles.label, selected && styles.labelSelected]}
                numberOfLines={1}
                testID={`tabs__label-${tab.id}`}
              >
                {tab.label}
              </Text>
              <StateDot id={tab.id} state={tab.state} />
            </Pressable>
          );
        })}
        {hidden > 0 ? (
          <Text style={styles.hidden} testID="tabs__hidden">
            {hidden} more on desktop
          </Text>
        ) : null}
      </ScrollView>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`All tabs, ${tabs.length}`}
        onPress={() => setSwitcher(true)}
        hitSlop={6}
        style={styles.button}
        testID="tabs__switcher"
      >
        <Text style={styles.count}>{tabs.length}</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="New chat"
        onPress={() => setPicker(true)}
        hitSlop={6}
        style={styles.button}
        testID="tabs__new"
      >
        <Text style={styles.plus}>+</Text>
      </Pressable>
      <TabSwitcher
        visible={switcher}
        onClose={() => setSwitcher(false)}
        tabs={tabs}
        active={active}
        hidden={hidden}
        actions={actions}
      />
      <AgentPicker
        visible={picker}
        onClose={() => setPicker(false)}
        agents={agents}
        onPick={actions.create}
      />
    </View>
  );
}

/** Every tab in a page sheet, for when the row holds more than fits. */
function TabSwitcher({
  visible,
  onClose,
  tabs,
  active,
  hidden,
  actions,
}: {
  visible: boolean;
  onClose: () => void;
  tabs: ChatTab[];
  active: string | null;
  hidden: number;
  actions: TabActions;
}) {
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={styles.sheet} testID="tabs__sheet">
        <SheetHeader title="Tabs" onClose={onClose} testID="tabs__sheet-done" />
        <ScrollView contentContainerStyle={styles.sheetBody}>
          {tabs.map((tab, i) => (
            <View key={tab.id} style={styles.sheetRow}>
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  actions.select(tab.id);
                  onClose();
                }}
                onLongPress={() => showTabMenu(tab, i, tabs.length, actions)}
                style={styles.sheetMain}
                testID={`tabs__sheet-tab-${tab.id}`}
              >
                <Text
                  style={[styles.sheetLabel, tab.id === active && styles.labelSelected]}
                  numberOfLines={1}
                >
                  {tab.label}
                </Text>
                <StateDot id={`sheet-${tab.id}`} state={tab.state} />
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Close ${tab.label}`}
                onPress={() => closeTab(actions, tab.id)}
                hitSlop={8}
                testID={`tabs__sheet-close-${tab.id}`}
              >
                <Text style={styles.close}>×</Text>
              </Pressable>
            </View>
          ))}
          {hidden > 0 ? (
            <Text style={styles.sheetNote}>
              {hidden === 1
                ? "1 terminal, file or browser tab is open on the desktop."
                : `${hidden} terminal, file or browser tabs are open on the desktop.`}
            </Text>
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  );
}

/** The configured coding agents, default first, as the web's "New agent" menu lists them. */
function AgentPicker({
  visible,
  onClose,
  agents,
  onPick,
}: {
  visible: boolean;
  onClose: () => void;
  agents: AgentChoice[];
  onPick: (agentId: string | undefined) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const pick = (agentId: string | undefined) => {
    setBusy(true);
    onPick(agentId)
      .then(onClose, () => Alert.alert("Couldn't start the chat"))
      .finally(() => setBusy(false));
  };
  // The default agent goes as "no pick", as on the web, so it follows the default-agent path.
  const choices = agents.length
    ? agents.map((a) => ({
        key: a.id,
        label: a.label,
        isDefault: a.isDefault,
        pick: a.isDefault ? undefined : a.id,
      }))
    : [{ key: "default", label: "Default agent", isDefault: true, pick: undefined }];
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={styles.sheet} testID="new-chat__sheet">
        <SheetHeader
          title="New chat"
          onClose={onClose}
          testID="new-chat__cancel"
          doneLabel="Cancel"
        />
        <ScrollView contentContainerStyle={styles.sheetBody}>
          {choices.map((c) => (
            <Pressable
              key={c.key}
              accessibilityRole="button"
              disabled={busy}
              onPress={() => pick(c.pick)}
              style={styles.sheetRow}
              testID={`new-chat__agent-${c.key}`}
            >
              <Text style={styles.sheetLabel}>{c.label}</Text>
              {c.isDefault ? <Text style={styles.sheetMeta}>Default</Text> : null}
            </Pressable>
          ))}
          {busy ? <ActivityIndicator color={colors.mutedForeground} style={styles.busy} /> : null}
        </ScrollView>
      </View>
    </Modal>
  );
}

function SheetHeader({
  title,
  onClose,
  testID,
  doneLabel = "Done",
}: {
  title: string;
  onClose: () => void;
  testID: string;
  doneLabel?: string;
}) {
  return (
    <View style={styles.sheetHeader}>
      <Text style={styles.sheetTitle} accessibilityRole="header">
        {title}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={doneLabel}
        onPress={onClose}
        hitSlop={8}
        testID={testID}
      >
        <Text style={styles.done}>{doneLabel}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    alignItems: "center",
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    paddingRight: 8,
  },
  scroll: { flex: 1 },
  row: { alignItems: "center", paddingHorizontal: 8 },
  tab: {
    alignItems: "center",
    borderBottomColor: "transparent",
    borderBottomWidth: 2,
    flexDirection: "row",
    gap: 6,
    maxWidth: 180,
    paddingHorizontal: 10,
    paddingVertical: 10,
  },
  tabSelected: { borderBottomColor: colors.foreground },
  label: { color: colors.mutedForeground, flexShrink: 1, fontSize: 14 },
  labelSelected: { color: colors.foreground, fontWeight: "600" },
  dot: { borderRadius: 4, height: 8, width: 8 },
  hidden: { color: colors.mutedForeground, fontSize: 12, paddingHorizontal: 10 },
  button: {
    alignItems: "center",
    height: 32,
    justifyContent: "center",
    minWidth: 32,
  },
  count: {
    borderColor: colors.mutedForeground,
    borderRadius: 4,
    borderWidth: 1,
    color: colors.foreground,
    fontSize: 12,
    fontWeight: "600",
    minWidth: 20,
    paddingHorizontal: 4,
    textAlign: "center",
  },
  plus: { color: colors.foreground, fontSize: 24, lineHeight: 28 },
  sheet: { backgroundColor: colors.background, flex: 1 },
  sheetHeader: {
    alignItems: "center",
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    justifyContent: "space-between",
    padding: 16,
  },
  sheetTitle: { color: colors.foreground, fontSize: 17, fontWeight: "600" },
  done: { color: colors.foreground, fontSize: 16, fontWeight: "600" },
  sheetBody: { paddingBottom: 32 },
  sheetRow: {
    alignItems: "center",
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  sheetMain: { alignItems: "center", flex: 1, flexDirection: "row", gap: 8 },
  sheetLabel: { color: colors.foreground, flexShrink: 1, fontSize: 16 },
  sheetMeta: { color: colors.mutedForeground, fontSize: 13, marginLeft: "auto" },
  sheetNote: { color: colors.mutedForeground, fontSize: 13, padding: 16 },
  close: { color: colors.mutedForeground, fontSize: 22, paddingHorizontal: 4 },
  busy: { marginTop: 16 },
});
