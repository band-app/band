import { Check, MessageSquare, Plus } from "lucide-react-native";
import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { type SessionSummary, sessionRows } from "../../lib/chat/session-history";
import { useHubSession } from "../../lib/hub-session";
import { colors } from "../../theme";
import { Icon } from "../icon";

type Load =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; sessions: SessionSummary[]; supported: boolean };

/**
 * The chat's past agent sessions in a page sheet, like the web's session history menu. The list is
 * fetched with `sessions.list` when the sheet opens, never before. A row switches the chat to that
 * session, "New session" starts a fresh one.
 */
export function SessionHistorySheet({
  visible,
  onClose,
  worktreeId,
  chatId,
  currentSessionId,
  onSwitch,
}: {
  visible: boolean;
  onClose: () => void;
  worktreeId: string;
  chatId: string;
  currentSessionId: string | undefined;
  onSwitch: (sessionId: string | undefined, summary?: string) => Promise<void>;
}) {
  const { client } = useHubSession();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [switching, setSwitching] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is the retry trigger
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setLoad({ state: "loading" });
    client.sessions.list
      .query({ worktreeId, chatId })
      .then((data) => {
        if (!cancelled) {
          setLoad({
            state: "ready",
            sessions: data.sessions as SessionSummary[],
            supported: data.supported,
          });
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setLoad({
            state: "error",
            message: err instanceof Error ? err.message : "Couldn't load the sessions.",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [visible, client, worktreeId, chatId, attempt]);

  const rows = useMemo(
    () => (load.state === "ready" ? sessionRows(load.sessions, currentSessionId, Date.now()) : []),
    [load, currentSessionId],
  );

  const choose = async (sessionId: string | undefined, summary?: string) => {
    if (switching) return;
    setSwitching(true);
    try {
      await onSwitch(sessionId, summary);
      onClose();
    } catch (err) {
      setLoad({
        state: "error",
        message: err instanceof Error ? err.message : "Couldn't switch the session.",
      });
    } finally {
      setSwitching(false);
    }
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      <View style={styles.sheet} testID="session-history">
        <View style={styles.header}>
          <Text style={styles.title} accessibilityRole="header">
            Sessions
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Done"
            onPress={onClose}
            hitSlop={8}
            testID="session-history__done"
          >
            <Text style={styles.done}>Done</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.body}>
          <View style={styles.card}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="New session"
              onPress={() => void choose(undefined)}
              style={styles.row}
              testID="session-history__new"
            >
              <Icon icon={Plus} />
              <Text style={styles.name}>New session</Text>
            </Pressable>
          </View>
          {load.state === "loading" ? (
            <ActivityIndicator
              color={colors.mutedForeground}
              style={styles.status}
              testID="session-history__loading"
            />
          ) : load.state === "error" ? (
            <View style={styles.status} testID="session-history__error">
              <Text style={styles.muted}>{load.message}</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Retry"
                onPress={() => setAttempt((n) => n + 1)}
                testID="session-history__retry"
              >
                <Text style={styles.done}>Retry</Text>
              </Pressable>
            </View>
          ) : !load.supported ? (
            <Text style={[styles.muted, styles.status]} testID="session-history__unsupported">
              This agent can't list its sessions.
            </Text>
          ) : rows.length === 0 ? (
            <Text style={[styles.muted, styles.status]} testID="session-history__empty">
              No sessions yet.
            </Text>
          ) : (
            <View style={styles.card} testID="session-history__list">
              {rows.map((row) => (
                <Pressable
                  key={row.sessionId}
                  accessibilityRole="button"
                  accessibilityLabel={row.label}
                  accessibilityState={{ selected: row.current }}
                  onPress={() => void choose(row.sessionId, row.label)}
                  style={styles.row}
                  testID={`session-history__row-${row.sessionId}`}
                >
                  <Icon icon={MessageSquare} />
                  <View style={styles.rowText}>
                    <Text style={styles.name} numberOfLines={1}>
                      {row.label}
                    </Text>
                    {row.age ? <Text style={styles.muted}>{row.age}</Text> : null}
                  </View>
                  {row.current ? (
                    <View testID="session-history__current">
                      <Icon icon={Check} />
                    </View>
                  ) : null}
                </Pressable>
              ))}
            </View>
          )}
        </ScrollView>
      </View>
    </Modal>
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
  card: { backgroundColor: colors.card, borderRadius: 10, overflow: "hidden" },
  row: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  rowText: { flex: 1, gap: 2 },
  name: { color: colors.foreground, fontSize: 16 },
  muted: { color: colors.mutedForeground, fontSize: 13 },
  status: { alignItems: "center", gap: 8, paddingVertical: 16, textAlign: "center" },
});
