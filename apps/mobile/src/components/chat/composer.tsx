import type { SlashCommandSkill } from "@band-app/client/composer";
import type { ChatEventFile } from "@band-app/shared/chat-events";
import { useCallback, useRef, useState } from "react";
import {
  ActionSheetIOS,
  Alert,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { type Attachment, toWireFiles } from "../../lib/composer/attachments";
import { useAttachmentPicker } from "../../lib/composer/use-attachment-picker";
import { useDraft } from "../../lib/composer/use-draft";
import { chatColors, colors } from "../../theme";
import { ComposerSuggestions } from "./composer-suggestions";

const MAX_ATTACHMENTS = 10;

/**
 * The message box at the bottom of a chat: a multiline field that grows, attachments (photo
 * library, camera, files), `/` and `@` suggestions, and one button that sends, or stops the
 * running turn when the field is empty. Return adds a line; only the button sends.
 */
export function Composer({
  worktreeId,
  running,
  skills,
  onSend,
  onStop,
}: {
  worktreeId: string;
  running: boolean;
  skills: SlashCommandSkill[];
  onSend: (text: string, files?: ChatEventFile[]) => Promise<void>;
  onStop: () => void;
}) {
  const [text, setText] = useDraft(worktreeId);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [hint, setHint] = useState<string | null>(null);
  const picker = useAttachmentPicker();
  const textRef = useRef(text);
  textRef.current = text;
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;

  const canSend = text.trim().length > 0 || attachments.length > 0;

  const submit = useCallback(async () => {
    if (!canSend) return;
    const sent = { text, attachments };
    setText("");
    setAttachments([]);
    setHint(null);
    try {
      await onSend(sent.text, toWireFiles(sent.attachments));
    } catch (err) {
      // Put the message back so nothing typed is lost.
      setText(textRef.current ? `${sent.text}\n${textRef.current}` : sent.text);
      setAttachments((current) => [...sent.attachments, ...current]);
      Alert.alert("Couldn't send", err instanceof Error ? err.message : "Try again.");
    }
  }, [canSend, text, attachments, onSend, setText]);

  const addFrom = useCallback(async (pick: () => Promise<Attachment[]>) => {
    try {
      const added = await pick();
      if (added.length > 0) {
        setAttachments((current) => [...current, ...added].slice(0, MAX_ATTACHMENTS));
        if (attachmentsRef.current.length + added.length > MAX_ATTACHMENTS) {
          Alert.alert("Too many attachments", `A message can carry up to ${MAX_ATTACHMENTS}.`);
        }
      }
    } catch (err) {
      Alert.alert("Couldn't attach", err instanceof Error ? err.message : "Try again.");
    }
  }, []);

  const openAttachMenu = useCallback(() => {
    const options = ["Photo library", "Take photo", "Choose file", "Cancel"];
    ActionSheetIOS.showActionSheetWithOptions({ options, cancelButtonIndex: 3 }, (index) => {
      if (index === 0) void addFrom(picker.photos);
      else if (index === 1) void addFrom(picker.camera);
      else if (index === 2) void addFrom(picker.files);
    });
  }, [addFrom, picker]);

  return (
    <View style={styles.root} testID="composer">
      <ComposerSuggestions
        text={text}
        skills={skills}
        worktreeId={worktreeId}
        onPick={(picked) => {
          setText(picked.text);
          setHint(picked.hint);
        }}
      />
      {attachments.length > 0 ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.chips}
          keyboardShouldPersistTaps="handled"
          testID="composer__attachments"
        >
          {attachments.map((a) => (
            <AttachmentChip
              key={a.id}
              attachment={a}
              onRemove={() => setAttachments((c) => c.filter((x) => x.id !== a.id))}
            />
          ))}
        </ScrollView>
      ) : null}
      {hint ? (
        <Text style={styles.hint} testID="composer__hint">
          {hint}
        </Text>
      ) : null}
      <View style={styles.box}>
        <TextInput
          accessibilityLabel="Message"
          multiline
          submitBehavior="newline"
          value={text}
          onChangeText={setText}
          placeholder={running ? "Queue a message…" : "Message the agent…"}
          placeholderTextColor={colors.mutedForeground}
          style={styles.input}
          autoCapitalize="sentences"
          testID="composer__input"
        />
        <View style={styles.toolbar}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Attach"
            onPress={openAttachMenu}
            hitSlop={8}
            style={styles.iconButton}
            testID="composer__attach"
          >
            <Text style={styles.icon}>＋</Text>
          </Pressable>
          {canSend || !running ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={running ? "Queue message" : "Send"}
              accessibilityState={{ disabled: !canSend }}
              disabled={!canSend}
              onPress={() => void submit()}
              style={[styles.send, !canSend && styles.sendDisabled]}
              testID="composer__send"
            >
              <Text style={styles.sendGlyph}>↑</Text>
            </Pressable>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Stop"
              onPress={onStop}
              style={styles.send}
              testID="composer__stop"
            >
              <View style={styles.stopSquare} />
            </Pressable>
          )}
        </View>
      </View>
    </View>
  );
}

function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: Attachment;
  onRemove: () => void;
}) {
  const { file } = attachment;
  const isImage = file.mediaType.startsWith("image/");
  return (
    <View style={styles.chip} testID="composer__attachment">
      {isImage ? <Image source={{ uri: file.url }} style={styles.thumb} /> : null}
      <Text style={styles.chipName} numberOfLines={1}>
        {file.filename ?? "File"}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Remove ${file.filename ?? "file"}`}
        onPress={onRemove}
        hitSlop={8}
        testID="composer__attachment-remove"
      >
        <Text style={styles.remove}>✕</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { paddingHorizontal: 12, paddingTop: 6 },
  chips: { gap: 6, paddingBottom: 6 },
  chip: {
    alignItems: "center",
    backgroundColor: colors.muted,
    borderRadius: 8,
    flexDirection: "row",
    gap: 6,
    maxWidth: 220,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  thumb: { borderRadius: 4, height: 28, width: 28 },
  chipName: { color: colors.mutedForeground, flexShrink: 1, fontSize: 13 },
  remove: { color: colors.mutedForeground, fontSize: 13 },
  hint: { color: colors.mutedForeground, fontSize: 12, paddingBottom: 4, paddingHorizontal: 4 },
  box: {
    backgroundColor: chatColors.bubble,
    borderColor: colors.border,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 10,
    paddingTop: 4,
  },
  input: {
    color: colors.foreground,
    fontSize: 16,
    maxHeight: 160,
    minHeight: 40,
    paddingTop: 8,
    paddingBottom: 8,
  },
  toolbar: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    paddingBottom: 6,
  },
  iconButton: { alignItems: "center", height: 32, justifyContent: "center", width: 32 },
  icon: { color: colors.mutedForeground, fontSize: 22 },
  send: {
    alignItems: "center",
    backgroundColor: colors.primary,
    borderRadius: 16,
    height: 32,
    justifyContent: "center",
    width: 32,
  },
  sendDisabled: { opacity: 0.35 },
  sendGlyph: { color: colors.primaryForeground, fontSize: 18, fontWeight: "700" },
  stopSquare: { backgroundColor: colors.primaryForeground, borderRadius: 2, height: 12, width: 12 },
});
