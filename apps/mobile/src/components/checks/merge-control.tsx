import {
  MERGE_METHODS,
  type MergeMethod,
  type MergeStatusInput,
  mergeMethodLabel,
  mergeStatus,
} from "@band-app/client/merge";
import { ChevronDown, GitMerge } from "lucide-react-native";
import { useState } from "react";
import { Linking, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { colors, tones } from "../../theme";

/**
 * The merge button, its method menu and the confirm step, as in the web's pull request panel.
 * The menu fades in place over the screen. Merging asks first, and a refusal from GitHub shows
 * under the button with the confirm step still open.
 */
export function MergeControl({
  review,
  onMerge,
}: {
  review: MergeStatusInput & { number: number; url: string };
  onMerge: (method: MergeMethod) => Promise<void>;
}) {
  const [menu, setMenu] = useState(false);
  const [confirming, setConfirming] = useState<MergeMethod | null>(null);
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = mergeStatus(review);
  const merged = review.state === "merged";

  const merge = async (method: MergeMethod) => {
    setMerging(true);
    setError(null);
    try {
      await onMerge(method);
      setConfirming(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMerging(false);
    }
  };

  const fill = merged ? tones.merged : tones.success;
  return (
    <View style={styles.wrap} testID="checks__merge-control">
      <View style={styles.bar}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !status.canMerge || merging }}
          disabled={!status.canMerge || merging}
          onPress={() => setConfirming("squash")}
          style={[
            styles.main,
            { backgroundColor: fill },
            !status.canMerge && !merged && styles.dim,
          ]}
          testID="checks__merge"
        >
          <GitMerge size={16} color="#ffffff" />
          <Text style={styles.mainText} testID="checks__merge-label">
            {status.label}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Merge options"
          onPress={() => setMenu(true)}
          style={[styles.chevron, { backgroundColor: fill }]}
          testID="checks__merge-menu"
        >
          <ChevronDown size={16} color="#ffffff" />
        </Pressable>
      </View>
      {status.hint && !status.canMerge ? (
        <Text style={styles.hint} testID="checks__merge-hint">
          {status.hint}
        </Text>
      ) : null}
      {confirming ? (
        <View style={styles.confirm} testID="checks__merge-confirm">
          <Text style={styles.confirmText}>
            {mergeMethodLabel(confirming)} #{review.number}?
          </Text>
          <Pressable
            accessibilityRole="button"
            disabled={merging}
            onPress={() => {
              setConfirming(null);
              setError(null);
            }}
            style={styles.cancel}
            testID="checks__merge-cancel"
          >
            <Text style={styles.cancelText}>Cancel</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={merging}
            onPress={() => void merge(confirming)}
            style={[styles.go, { backgroundColor: tones.success }, merging && styles.dim]}
            testID="checks__merge-confirm-button"
          >
            <Text style={styles.goText}>{merging ? "Merging…" : "Merge"}</Text>
          </Pressable>
        </View>
      ) : null}
      {error ? (
        <Text style={styles.error} accessibilityRole="alert" testID="checks__merge-error">
          {error}
        </Text>
      ) : null}
      <Modal visible={menu} transparent animationType="fade" onRequestClose={() => setMenu(false)}>
        <View style={styles.root}>
          <Pressable
            style={styles.backdrop}
            onPress={() => setMenu(false)}
            accessibilityRole="button"
            accessibilityLabel="Close"
            testID="checks__merge-menu-backdrop"
          />
          <View style={styles.sheet} accessibilityViewIsModal testID="checks__merge-sheet">
            {MERGE_METHODS.map(({ method, label }) => (
              <Pressable
                key={method}
                accessibilityRole="button"
                accessibilityState={{ disabled: !status.canMerge }}
                disabled={!status.canMerge}
                onPress={() => {
                  setMenu(false);
                  setConfirming(method);
                }}
                style={[styles.item, !status.canMerge && styles.dim]}
                testID={`checks__merge-method-${method}`}
              >
                <Text style={styles.itemText}>{label}</Text>
              </Pressable>
            ))}
            <Pressable
              accessibilityRole="link"
              onPress={() => {
                setMenu(false);
                if (/^https?:\/\//.test(review.url))
                  void Linking.openURL(review.url).catch(() => {});
              }}
              style={[styles.item, styles.itemLast]}
              testID="checks__merge-open"
            >
              <Text style={styles.itemText}>Open on GitHub</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8, paddingHorizontal: 12, paddingVertical: 8 },
  bar: { flexDirection: "row", gap: 2 },
  main: {
    alignItems: "center",
    borderBottomLeftRadius: 12,
    borderTopLeftRadius: 12,
    flex: 1,
    flexDirection: "row",
    gap: 8,
    height: 44,
    justifyContent: "center",
  },
  mainText: { color: "#ffffff", fontSize: 15, fontWeight: "600" },
  chevron: {
    alignItems: "center",
    borderBottomRightRadius: 12,
    borderTopRightRadius: 12,
    height: 44,
    justifyContent: "center",
    width: 44,
  },
  dim: { opacity: 0.5 },
  hint: { color: colors.mutedForeground, fontSize: 13 },
  confirm: {
    alignItems: "center",
    borderColor: colors.border,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 8,
    padding: 10,
  },
  confirmText: { color: colors.foreground, flex: 1, fontSize: 14 },
  cancel: { height: 36, justifyContent: "center", paddingHorizontal: 10 },
  cancelText: { color: colors.mutedForeground, fontSize: 14 },
  go: { borderRadius: 18, height: 36, justifyContent: "center", paddingHorizontal: 16 },
  goText: { color: "#ffffff", fontSize: 14, fontWeight: "600" },
  error: { color: colors.destructive, fontSize: 13 },
  root: { flex: 1, justifyContent: "flex-end" },
  backdrop: { backgroundColor: "rgba(0,0,0,0.4)", ...StyleSheet.absoluteFill },
  sheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingBottom: 28,
    paddingTop: 8,
  },
  item: {
    borderBottomColor: colors.divider,
    borderBottomWidth: StyleSheet.hairlineWidth,
    justifyContent: "center",
    marginHorizontal: 16,
    minHeight: 52,
  },
  itemLast: { borderBottomWidth: 0 },
  itemText: { color: colors.foreground, fontSize: 16 },
});
