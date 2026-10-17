import type { SlashCommandSkill } from "@band-app/client/composer";
import type { sessionPickers } from "@band-app/client/session-pickers";
import type { ChatEventFile } from "@band-app/shared/chat-events";
import { insertAtSelection } from "@band-app/shared/dictation-text";
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
import { useDictation } from "../../lib/composer/use-dictation";
import { useDraft } from "../../lib/composer/use-draft";
import { colors, useScheme } from "../../theme";
import { Glass, MicGlyph, PlusGlyph } from "../glass";
import { ChatHeader, type SessionsControl } from "./chat-header";
import { ComposerSuggestions } from "./composer-suggestions";

const MAX_ATTACHMENTS = 10;

/**
 * The message box at the bottom of a chat, a floating rounded bar: + on the left, a field that
 * grows, and one button that sends, or stops the running turn when the field is empty. Focused,
 * it expands into a card above the keyboard with the attachment chips over the text and the model
 * and mode pills beside +. Attachments come from the photo library, camera or files, `/` and `@`
 * suggestions open above it. Return adds a line; only the button sends.
 */
export function Composer({
  worktreeId,
  running,
  skills,
  pickers,
  setConfigOption,
  sessions,
  onSend,
  onStop,
}: {
  sessions?: SessionsControl;
  worktreeId: string;
  running: boolean;
  skills: SlashCommandSkill[];
  pickers: ReturnType<typeof sessionPickers>;
  setConfigOption: (configId: string, value: string) => Promise<void>;
  onSend: (text: string, files?: ChatEventFile[]) => Promise<void>;
  onStop: () => void;
}) {
  const scheme = useScheme();
  const [focused, setFocused] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [text, setText] = useDraft(worktreeId);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [hint, setHint] = useState<string | null>(null);
  const picker = useAttachmentPicker();
  const textRef = useRef(text);
  textRef.current = text;
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;

  // Dictated text lands over the selection and the caret moves after it. It is never sent.
  const insertDictated = useCallback(
    (dictated: string) => {
      const at = selectionRef.current;
      const length = textRef.current.length;
      const next = insertAtSelection(
        textRef.current,
        Math.min(at.start, length),
        Math.min(at.end, length),
        dictated,
      );
      setText(next.value);
      setSelection({ start: next.caret, end: next.caret });
    },
    [setText],
  );
  const dictation = useDictation(insertDictated);
  const dictating = dictation.state.phase === "recording";
  const transcribing = dictation.state.phase === "transcribing";

  const canSend = text.trim().length > 0 || attachments.length > 0;
  const expanded = focused || sheetOpen || attachments.length > 0;

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

  const plus = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Attach"
      onPress={openAttachMenu}
      hitSlop={8}
      style={[styles.plus, expanded && styles.plusSmall]}
      testID="composer__attach"
    >
      <PlusGlyph size={expanded ? 16 : 18} />
    </Pressable>
  );
  const mic = dictation.available ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={dictating ? "Stop dictation" : "Dictate"}
      accessibilityState={{ busy: transcribing, selected: dictating }}
      disabled={transcribing || dictation.state.phase === "starting"}
      onPress={dictation.toggle}
      hitSlop={8}
      style={[styles.plus, expanded && styles.plusSmall, dictating && styles.micActive]}
      testID="composer__mic"
    >
      {dictating ? <View style={styles.micStop} /> : <MicGlyph size={expanded ? 16 : 18} />}
    </Pressable>
  ) : null;
  const action =
    canSend || !running ? (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={running ? "Queue message" : "Send"}
        accessibilityState={{ disabled: !canSend }}
        disabled={!canSend}
        onPress={() => void submit()}
        style={[styles.send, expanded && styles.plusSmall, !canSend && styles.sendDisabled]}
        testID="composer__send"
      >
        <Text style={styles.sendGlyph}>↑</Text>
      </Pressable>
    ) : (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Stop"
        onPress={onStop}
        style={[styles.send, expanded && styles.plusSmall]}
        testID="composer__stop"
      >
        <View style={styles.stopSquare} />
      </Pressable>
    );

  return (
    <View style={styles.root} testID="composer">
      <ComposerSuggestions
        text={text}
        skills={skills}
        worktreeId={worktreeId}
        onPick={(picked) => {
          setText(picked.text);
          setSelection({ start: picked.text.length, end: picked.text.length });
          setHint(picked.hint);
        }}
      />
      <Glass radius={expanded ? 26 : 28} innerStyle={expanded ? styles.cardExpanded : styles.card}>
        {expanded ? (
          <>
            <View style={styles.grab} />
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
          </>
        ) : null}
        {dictating || transcribing || dictation.state.error ? (
          <View style={styles.listening} testID="composer__listening">
            {dictating ? (
              <>
                <View style={styles.recDot} />
                <Text style={styles.listeningText}>Listening</Text>
                <Text style={styles.listeningText} testID="composer__listening-timer">
                  {formatElapsed(dictation.elapsed)}
                </Text>
                <View style={styles.spacer} />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Cancel dictation"
                  onPress={dictation.cancel}
                  hitSlop={8}
                  testID="composer__listening-cancel"
                >
                  <Text style={styles.cancelText}>Cancel</Text>
                </Pressable>
              </>
            ) : transcribing ? (
              <Text style={styles.listeningText}>Transcribing…</Text>
            ) : (
              <Text style={styles.errorText} testID="composer__dictation-error">
                {dictation.state.error}
              </Text>
            )}
          </View>
        ) : null}
        <View style={expanded ? styles.fieldExpanded : styles.fieldRow}>
          {expanded ? null : plus}
          <TextInput
            keyboardAppearance={scheme}
            accessibilityLabel="Message"
            multiline
            submitBehavior="newline"
            value={text}
            onChangeText={setText}
            selection={selection}
            onSelectionChange={(e) => setSelection(e.nativeEvent.selection)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder={running ? "Queue a message…" : "Follow up…"}
            placeholderTextColor={colors.faint}
            style={[styles.input, expanded && styles.inputExpanded]}
            autoCapitalize="sentences"
            autoCorrect={false}
            spellCheck={false}
            testID="composer__input"
          />
          {expanded ? null : mic}
          {expanded ? null : action}
        </View>
        {expanded ? (
          <View style={styles.bar}>
            {plus}
            <ChatHeader
              pickers={pickers}
              setConfigOption={setConfigOption}
              sessions={sessions}
              onOpenChange={setSheetOpen}
            />
            <View style={styles.spacer} />
            {mic}
            {action}
          </View>
        ) : null}
      </Glass>
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

function formatElapsed(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

const styles = StyleSheet.create({
  listening: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    paddingBottom: 4,
    paddingHorizontal: 12,
    paddingTop: 4,
  },
  recDot: { backgroundColor: colors.destructive, borderRadius: 5, height: 10, width: 10 },
  listeningText: { color: colors.mutedForeground, fontSize: 13 },
  cancelText: { color: colors.foreground, fontSize: 13, fontWeight: "600" },
  errorText: { color: colors.destructive, flex: 1, fontSize: 12.5 },
  micActive: { backgroundColor: colors.destructive },
  micStop: { backgroundColor: colors.primaryForeground, borderRadius: 2, height: 12, width: 12 },
  root: { paddingBottom: 6, paddingHorizontal: 12, paddingTop: 6 },
  card: { alignItems: "stretch", minHeight: 56, padding: 6 },
  cardExpanded: { paddingBottom: 8, paddingHorizontal: 8, paddingTop: 8 },
  grab: {
    alignSelf: "center",
    backgroundColor: colors.grab,
    borderRadius: 3,
    height: 5,
    marginBottom: 8,
    width: 38,
  },
  fieldRow: { alignItems: "center", flexDirection: "row", gap: 8 },
  fieldExpanded: { paddingHorizontal: 6 },
  input: {
    color: colors.foreground,
    flex: 1,
    fontSize: 16,
    maxHeight: 140,
    minHeight: 40,
    paddingBottom: 8,
    paddingTop: 10,
  },
  inputExpanded: { flex: 0, minHeight: 74 },
  bar: { alignItems: "center", flexDirection: "row", gap: 8 },
  spacer: { flex: 1 },
  plus: {
    alignItems: "center",
    backgroundColor: colors.muted,
    borderRadius: 22,
    height: 44,
    justifyContent: "center",
    width: 44,
  },
  plusSmall: { borderRadius: 18, height: 36, width: 36 },
  send: {
    alignItems: "center",
    backgroundColor: colors.primary,
    borderRadius: 22,
    height: 44,
    justifyContent: "center",
    width: 44,
  },
  sendDisabled: { opacity: 0.35 },
  sendGlyph: { color: colors.primaryForeground, fontSize: 20, fontWeight: "700" },
  stopSquare: { backgroundColor: colors.primaryForeground, borderRadius: 2, height: 12, width: 12 },
  chips: { gap: 6, paddingBottom: 8, paddingHorizontal: 6 },
  chip: {
    alignItems: "center",
    backgroundColor: colors.muted,
    borderRadius: 10,
    flexDirection: "row",
    gap: 6,
    height: 30,
    maxWidth: 220,
    paddingHorizontal: 9,
  },
  thumb: { borderRadius: 4, height: 20, width: 20 },
  chipName: { color: colors.foreground, flexShrink: 1, fontSize: 12.5 },
  remove: { color: colors.mutedForeground, fontSize: 12 },
  hint: { color: colors.mutedForeground, fontSize: 12, paddingBottom: 4, paddingHorizontal: 10 },
});
