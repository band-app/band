import { describeWatch, formatExpiry } from "@band-app/client/subscription-label";
import { memo, useState } from "react";
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSubscriptions } from "../../lib/chat/use-subscriptions";
import { colors } from "../../theme";

/**
 * Shows that a chat is listening for events and lists what it waits for, like the web's
 * `ListeningPill`. Renders nothing when the chat has no subscriptions. Tapping the pill opens the
 * list, and each entry can be removed.
 */
export const ListeningPill = memo(function ListeningPill({ chatId }: { chatId: string }) {
  const { subscriptions, remove } = useSubscriptions(chatId);
  const [open, setOpen] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  if (subscriptions.length === 0 && !open) return null;

  const removeOne = async (id: string) => {
    setRemoving(id);
    try {
      await remove(id);
    } catch {
      Alert.alert("Couldn't stop listening", "Try again.");
    } finally {
      setRemoving(null);
    }
  };

  const now = Date.now();
  return (
    <>
      {subscriptions.length > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Listening, ${subscriptions.length}`}
          onPress={() => setOpen(true)}
          style={styles.pill}
          testID="listening__pill"
        >
          <Text style={styles.pillText}>
            ◉ Listening <Text testID="listening__count">{subscriptions.length}</Text>
          </Text>
        </Pressable>
      ) : null}
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)} />
        <View style={styles.sheet} testID="listening__list">
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>Listening</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close"
              onPress={() => setOpen(false)}
              hitSlop={8}
              testID="listening__close"
            >
              <Text style={styles.close}>✕</Text>
            </Pressable>
          </View>
          {subscriptions.length === 0 ? (
            <Text style={styles.empty} testID="listening__empty">
              Not listening for anything.
            </Text>
          ) : (
            <ScrollView>
              {subscriptions.map((sub) => {
                const { source, watches } = describeWatch(sub);
                return (
                  <View key={sub.id} style={styles.item} testID={`listening__item-${sub.id}`}>
                    <View style={styles.itemText}>
                      <Text style={styles.source}>
                        {source} <Text style={styles.watches}>{watches}</Text>
                      </Text>
                      <Text style={styles.meta}>
                        {sub.wakeups}/{sub.maxWakeups} wakeups · {formatExpiry(sub.expiresAt, now)}
                      </Text>
                    </View>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Stop listening to ${watches}`}
                      disabled={removing === sub.id}
                      onPress={() => void removeOne(sub.id)}
                      hitSlop={8}
                      style={[styles.remove, removing === sub.id && styles.dim]}
                      testID={`listening__remove-${sub.id}`}
                    >
                      <Text style={styles.removeText}>Remove</Text>
                    </Pressable>
                  </View>
                );
              })}
            </ScrollView>
          )}
        </View>
      </Modal>
    </>
  );
});

const styles = StyleSheet.create({
  pill: {
    backgroundColor: colors.background,
    borderColor: colors.border,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 10,
    paddingVertical: 5,
    position: "absolute",
    right: 12,
    top: 8,
    zIndex: 2,
  },
  pillText: { color: colors.mutedForeground, fontSize: 13 },
  backdrop: { backgroundColor: "rgba(0,0,0,0.5)", flex: 1 },
  sheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    maxHeight: "60%",
    paddingBottom: 32,
    paddingHorizontal: 16,
    paddingTop: 14,
  },
  sheetHeader: { alignItems: "center", flexDirection: "row", justifyContent: "space-between" },
  sheetTitle: { color: colors.foreground, fontSize: 17, fontWeight: "600" },
  close: { color: colors.mutedForeground, fontSize: 18 },
  empty: { color: colors.mutedForeground, fontSize: 15, paddingVertical: 20 },
  item: {
    alignItems: "center",
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 12,
    paddingVertical: 12,
  },
  itemText: { flex: 1, gap: 2 },
  source: { color: colors.foreground, fontSize: 15, fontWeight: "600" },
  watches: { color: colors.mutedForeground, fontWeight: "400" },
  meta: { color: colors.mutedForeground, fontSize: 13 },
  remove: { paddingHorizontal: 8, paddingVertical: 6 },
  removeText: { color: colors.destructive, fontSize: 15 },
  dim: { opacity: 0.5 },
});
