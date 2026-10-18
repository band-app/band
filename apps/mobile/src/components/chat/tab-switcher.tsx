import { MessageSquarePlus, SquareTerminal } from "lucide-react-native";
import { useRef, useState } from "react";
import {
  ActionSheetIOS,
  ActivityIndicator,
  Alert,
  Animated,
  Modal,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import type { AgentChoice, ChatTab } from "../../lib/chat/use-worktree-tabs";
import { colors, tones } from "../../theme";
import { AgentIcon } from "../agent-icon";
import { BottomSheet } from "../bottom-sheet";
import { Icon } from "../icon";
import { StateIcon } from "../state-icon";

export interface TabActions {
  select: (id: string) => void;
  close: (id: string) => Promise<void>;
  move: (id: string, delta: number) => void;
  rename: (id: string, name: string) => Promise<void>;
  create: (agentId: string | undefined) => Promise<void>;
  createTerminal: () => Promise<void>;
}

export function closeTab(actions: TabActions, id: string) {
  actions.close(id).catch(() => Alert.alert("Couldn't close the tab"));
}

export function renameTab(tab: ChatTab, actions: TabActions) {
  Alert.prompt(
    "Rename tab",
    undefined,
    (name) => {
      actions.rename(tab.id, name).catch(() => Alert.alert("Couldn't rename the chat"));
    },
    "plain-text",
    tab.label,
  );
}

/** Rename, move and close for one tab, in the system's action sheet. */
export function showTabMenu(tab: ChatTab, index: number, count: number, actions: TabActions) {
  const options = ["Rename", "Move up", "Move down", "Close tab", "Cancel"];
  ActionSheetIOS.showActionSheetWithOptions(
    {
      title: tab.label,
      options,
      destructiveButtonIndex: 3,
      cancelButtonIndex: 4,
      disabledButtonIndices: [
        ...(tab.kind === "term" ? [0] : []),
        ...(index === 0 ? [1] : []),
        ...(index === count - 1 ? [2] : []),
      ],
    },
    (choice) => {
      if (choice === 0) renameTab(tab, actions);
      else if (choice === 1) actions.move(tab.id, -1);
      else if (choice === 2) actions.move(tab.id, 1);
      else if (choice === 3) closeTab(actions, tab.id);
    },
  );
}

/** Dragging a row this far left closes its tab. */
const SWIPE_CLOSE = 90;

/**
 * One tab in the sheet: icon, name, a live line, the agent's state. Swipe left to close it, long
 * press for rename, move and close.
 */
function TabRow({
  tab,
  index,
  count,
  current,
  actions,
  onSelect,
}: {
  tab: ChatTab;
  index: number;
  count: number;
  current: boolean;
  actions: TabActions;
  onSelect: () => void;
}) {
  const x = useRef(new Animated.Value(0)).current;
  const live = useRef({ tab, actions });
  live.current = { tab, actions };
  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) =>
        Math.abs(g.dx) > 12 && Math.abs(g.dx) > 2 * Math.abs(g.dy),
      onPanResponderMove: (_e, g) => x.setValue(Math.min(0, g.dx)),
      onPanResponderRelease: (_e, g) => {
        if (g.dx < -SWIPE_CLOSE) {
          closeTab(live.current.actions, live.current.tab.id);
        }
        Animated.spring(x, { toValue: 0, useNativeDriver: true }).start();
      },
      onPanResponderTerminate: () =>
        Animated.spring(x, { toValue: 0, useNativeDriver: true }).start(),
    }),
  ).current;

  return (
    <View style={styles.rowWrap}>
      <View style={styles.closeBehind} pointerEvents="none">
        <Text style={styles.closeText}>Close</Text>
      </View>
      <Animated.View
        style={[styles.tabRow, current && styles.tabRowCurrent, { transform: [{ translateX: x }] }]}
        {...pan.panHandlers}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: current }}
          accessibilityLabel={`${tab.label}, ${tab.summary}`}
          accessibilityActions={[{ name: "delete", label: "Close tab" }]}
          onAccessibilityAction={() => closeTab(actions, tab.id)}
          onPress={onSelect}
          onLongPress={() => showTabMenu(tab, index, count, actions)}
          style={styles.rowPress}
          testID={`tabs__sheet-tab-${tab.id}`}
        >
          <View style={styles.tabIcon}>
            {tab.kind === "term" ? (
              <Icon icon={SquareTerminal} color={colors.mutedForeground} />
            ) : (
              <AgentIcon type={tab.agentType} size={18} color={colors.mutedForeground} />
            )}
          </View>
          <View style={styles.tx}>
            <Text style={styles.txName} numberOfLines={1} testID={`tabs__label-${tab.id}`}>
              {tab.label}
            </Text>
            <Text style={styles.txSummary} numberOfLines={1}>
              {tab.summary}
            </Text>
          </View>
          <StateIcon state={tab.shown} />
        </Pressable>
      </Animated.View>
    </View>
  );
}

/**
 * The worktree's chat tabs as a bottom sheet over a scrim. Tapping a row shows that tab, "+ Chat"
 * starts one, and the note at the foot counts the tabs of other kinds that only the desktop shows.
 */
export function TabSwitcher({
  visible,
  onClose,
  title,
  tabs,
  active,
  hidden,
  actions,
  onNew,
  onNewTerminal,
  onDismiss,
}: {
  visible: boolean;
  onClose: () => void;
  title: string;
  tabs: ChatTab[];
  active: string | null;
  hidden: number;
  actions: TabActions;
  /** "+ Chat" was tapped; the caller closes the sheet and opens its agent picker. */
  onNew: () => void;
  /** "+ Terminal" was tapped; the caller opens a shell and closes the sheet. */
  onNewTerminal: () => void;
  /** The sheet finished closing. */
  onDismiss?: () => void;
}) {
  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      onDismiss={onDismiss}
      style={styles.sheet}
      testID="tabs__sheet"
      backdropTestID="tabs__sheet-done"
      backdropLabel="Close tabs"
    >
      <Text style={styles.sheetTitle} accessibilityRole="header">
        {tabs.length === 1 ? "1 tab" : `${tabs.length} tabs`}
      </Text>
      <Text style={styles.sheetSub} numberOfLines={1}>
        {title}
      </Text>
      <ScrollView style={styles.list} bounces={false}>
        {tabs.map((tab, i) => (
          <TabRow
            key={tab.id}
            tab={tab}
            index={i}
            count={tabs.length}
            current={tab.id === active}
            actions={actions}
            onSelect={() => {
              actions.select(tab.id);
              onClose();
            }}
          />
        ))}
        {hidden > 0 ? (
          <Text style={styles.note} testID="tabs__hidden">
            {hidden} more on desktop
          </Text>
        ) : null}
      </ScrollView>
      <View style={styles.newRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="New chat"
          onPress={onNew}
          style={styles.newChat}
          testID="tabs__new"
        >
          <Icon icon={MessageSquarePlus} size="sm" />
          <Text style={styles.newChatText}>Chat</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="New terminal"
          onPress={onNewTerminal}
          style={styles.newChat}
          testID="tabs__new-terminal"
        >
          <Icon icon={SquareTerminal} size="sm" />
          <Text style={styles.newChatText}>Terminal</Text>
        </Pressable>
      </View>
    </BottomSheet>
  );
}

/** The configured coding agents, default first, as the web's "New agent" menu lists them. */
export function AgentPicker({
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
        type: a.type,
        isDefault: a.isDefault,
        pick: a.isDefault ? undefined : a.id,
      }))
    : [
        {
          key: "default",
          label: "Default agent",
          type: undefined,
          isDefault: true,
          pick: undefined,
        },
      ];
  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={styles.pageSheet} testID="new-chat__sheet">
        <View style={styles.pageHeader}>
          <Text style={styles.pageTitle} accessibilityRole="header">
            New chat
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel"
            onPress={onClose}
            hitSlop={8}
            testID="new-chat__cancel"
          >
            <Text style={styles.done}>Cancel</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.pageBody}>
          {choices.map((c) => (
            <Pressable
              key={c.key}
              accessibilityRole="button"
              disabled={busy}
              onPress={() => pick(c.pick)}
              style={styles.agentRow}
              testID={`new-chat__agent-${c.key}`}
            >
              <AgentIcon type={c.type} size={20} />
              <Text style={styles.agentLabel}>{c.label}</Text>
              {c.isDefault ? <Text style={styles.agentMeta}>Default</Text> : null}
            </Pressable>
          ))}
          {busy ? <ActivityIndicator color={colors.mutedForeground} style={styles.busy} /> : null}
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheet: { maxHeight: "75%" },
  sheetTitle: { color: colors.foreground, fontSize: 20, fontWeight: "600", marginHorizontal: 4 },
  sheetSub: { color: colors.mutedForeground, fontSize: 13, marginBottom: 12, marginHorizontal: 4 },
  list: { flexGrow: 0 },
  rowWrap: { justifyContent: "center" },
  closeBehind: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "flex-end",
    backgroundColor: tones.failure,
    borderRadius: 16,
    justifyContent: "center",
    paddingRight: 20,
  },
  closeText: { color: "#fff", fontSize: 15, fontWeight: "600" },
  tabRow: { backgroundColor: colors.background, borderRadius: 16 },
  tabRowCurrent: { backgroundColor: colors.muted },
  rowPress: {
    alignItems: "center",
    flexDirection: "row",
    gap: 12,
    minHeight: 58,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  tabIcon: {
    alignItems: "center",
    backgroundColor: colors.muted,
    borderRadius: 10,
    height: 34,
    justifyContent: "center",
    width: 34,
  },
  tx: { flex: 1, minWidth: 0 },
  txName: { color: colors.foreground, fontSize: 16, fontWeight: "500" },
  txSummary: { color: colors.mutedForeground, fontSize: 13 },
  note: { color: colors.mutedForeground, fontSize: 13, padding: 12 },
  newChat: {
    alignItems: "center",
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 6,
    height: 44,
    flex: 1,
    justifyContent: "center",
  },
  newRow: { flexDirection: "row", gap: 10, marginTop: 12 },
  newChatText: { color: colors.foreground, fontSize: 14, fontWeight: "500" },
  pageSheet: { backgroundColor: colors.background, flex: 1 },
  pageHeader: {
    alignItems: "center",
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    justifyContent: "space-between",
    padding: 16,
  },
  pageTitle: { color: colors.foreground, fontSize: 17, fontWeight: "600" },
  done: { color: colors.foreground, fontSize: 16, fontWeight: "600" },
  pageBody: { paddingBottom: 32 },
  agentRow: {
    alignItems: "center",
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  agentLabel: { color: colors.foreground, flexShrink: 1, fontSize: 16 },
  agentMeta: { color: colors.mutedForeground, fontSize: 13, marginLeft: "auto" },
  busy: { marginTop: 16 },
});
