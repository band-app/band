import type { QueuedChatMessage } from "@band-app/shared/chat-events";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { moveItem } from "../../lib/composer/queue";
import { chatColors, colors, useScheme } from "../../theme";

/**
 * Messages sent while the agent runs, listed above the composer as unsent bubbles. They go out
 * in order when the turn ends. Each can be edited, removed or moved up and down; the web drags
 * them, and a phone's list can't tell a drag from a scroll without a gesture library.
 */
export function QueuedMessages({
  messages,
  onRemove,
  onEdit,
  onReorder,
}: {
  messages: QueuedChatMessage[];
  onRemove: (id: string) => void;
  onEdit: (id: string, text: string) => void;
  onReorder: (next: QueuedChatMessage[]) => void;
}) {
  if (messages.length === 0) return null;
  return (
    <View style={styles.root} testID="queue__list">
      <View style={styles.divider}>
        <View style={styles.rule} />
        <Text style={styles.dividerText}>Queued · sent when the agent finishes</Text>
        <View style={styles.rule} />
      </View>
      <ScrollView style={styles.scroll} keyboardShouldPersistTaps="handled">
        {messages.map((message, index) => (
          <QueuedMessage
            key={message.id}
            message={message}
            canUp={index > 0}
            canDown={index < messages.length - 1}
            onRemove={() => onRemove(message.id)}
            onEdit={(text) => onEdit(message.id, text)}
            onUp={() => onReorder(moveItem(messages, index, index - 1))}
            onDown={() => onReorder(moveItem(messages, index, index + 1))}
          />
        ))}
      </ScrollView>
    </View>
  );
}

function QueuedMessage({
  message,
  canUp,
  canDown,
  onRemove,
  onEdit,
  onUp,
  onDown,
}: {
  message: QueuedChatMessage;
  canUp: boolean;
  canDown: boolean;
  onRemove: () => void;
  onEdit: (text: string) => void;
  onUp: () => void;
  onDown: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.text);

  const scheme = useScheme();
  const save = () => {
    const next = draft.trim();
    if (!next) return;
    if (next !== message.text) onEdit(next);
    setEditing(false);
  };

  if (editing) {
    return (
      <View style={styles.editor} testID="queue__editor">
        <TextInput
          accessibilityLabel="Edit queued message"
          autoFocus
          keyboardAppearance={scheme}
          multiline
          value={draft}
          onChangeText={setDraft}
          style={styles.editInput}
          placeholderTextColor={colors.mutedForeground}
          testID="queue__edit-input"
        />
        <View style={styles.actions}>
          <Action
            label="Cancel"
            glyph="✕"
            onPress={() => setEditing(false)}
            testID="queue__edit-cancel"
          />
          <Action
            label="Save"
            glyph="✓"
            onPress={save}
            disabled={!draft.trim()}
            testID="queue__edit-save"
          />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.item} testID="queue__item">
      <View style={styles.bubble}>
        {message.files?.length ? (
          <Text style={styles.files} numberOfLines={1}>
            {message.files.map((f) => f.filename ?? "File").join(", ")}
          </Text>
        ) : null}
        {message.text.trim() ? (
          <Text style={styles.text} testID="queue__text">
            {message.text}
          </Text>
        ) : null}
      </View>
      <View style={styles.actions}>
        <Action label="Move up" glyph="↑" onPress={onUp} disabled={!canUp} testID="queue__up" />
        <Action
          label="Move down"
          glyph="↓"
          onPress={onDown}
          disabled={!canDown}
          testID="queue__down"
        />
        <Action
          label="Edit queued message"
          glyph="✎"
          onPress={() => {
            setDraft(message.text);
            setEditing(true);
          }}
          testID="queue__edit"
        />
        <Action label="Delete queued message" glyph="🗑" onPress={onRemove} testID="queue__delete" />
      </View>
    </View>
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
      hitSlop={6}
      onPress={onPress}
      style={[styles.action, disabled && styles.disabled]}
      testID={testID}
    >
      <Text style={styles.glyph}>{glyph}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { paddingHorizontal: 12, paddingTop: 6 },
  divider: { alignItems: "center", flexDirection: "row", gap: 8, marginBottom: 6 },
  rule: { backgroundColor: colors.border, flex: 1, height: StyleSheet.hairlineWidth },
  dividerText: { color: colors.mutedForeground, fontSize: 12 },
  scroll: { maxHeight: 168 },
  item: { alignItems: "flex-end", gap: 2, marginBottom: 6 },
  bubble: {
    borderColor: chatColors.bubbleBorder,
    borderRadius: 8,
    borderWidth: 2,
    maxWidth: "92%",
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  files: { color: colors.mutedForeground, fontSize: 12, marginBottom: 4 },
  text: { color: colors.foreground, fontSize: 15 },
  actions: { flexDirection: "row", gap: 4, justifyContent: "flex-end" },
  action: { alignItems: "center", height: 28, justifyContent: "center", width: 32 },
  disabled: { opacity: 0.3 },
  glyph: { color: colors.mutedForeground, fontSize: 15 },
  editor: {
    backgroundColor: colors.muted,
    borderColor: colors.border,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 6,
    padding: 8,
  },
  editInput: { color: colors.foreground, fontSize: 16, maxHeight: 120, minHeight: 36 },
});
