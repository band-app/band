import type { Entry } from "@band-app/client/transcript";
import type { ChatEventFile } from "@band-app/shared/chat-events";
import { MoreHorizontal } from "lucide-react-native";
import { memo } from "react";
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from "react-native";
import type { ChatRow } from "../../lib/chat/rows";
import { chatColors, colors, tones } from "../../theme";
import { useAssetSource, useChat, useOpen } from "./chat-context";
import { Markdown } from "./markdown";
import { ToolCall, ToolGroup } from "./tool-call";

function FileView({ file }: { file: ChatEventFile }) {
  const source = useAssetSource(file.url);
  if (file.mediaType.startsWith("image/")) {
    return (
      <Image
        source={source}
        style={styles.image}
        resizeMode="contain"
        accessibilityLabel={file.filename ?? "Image"}
        testID="chat__image"
      />
    );
  }
  return (
    <View style={styles.file}>
      <Text style={styles.fileName} numberOfLines={1}>
        {file.filename ?? "File"}
      </Text>
      <Text style={styles.fileType}>{file.mediaType}</Text>
    </View>
  );
}

function Thought({ id, text }: { id: string; text: string }) {
  const [open, toggle] = useOpen(id);
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={toggle}
        hitSlop={4}
        style={styles.thoughtRow}
        testID="chat__thought"
      >
        <Text style={styles.muted}>Thinking {open ? "▾" : "▸"}</Text>
      </Pressable>
      {open ? <Text style={styles.thoughtText}>{text}</Text> : null}
    </View>
  );
}

/** The answer as the web chat words it: the picked option's name, not its id. */
function answerText(entry: Extract<Entry, { kind: "permission" | "elicitation" }>): string {
  if (entry.kind === "elicitation") {
    if (entry.answer === "accept") return "Answer sent to the agent";
    return entry.answer === "decline" ? "Skipped" : "Not answered";
  }
  if (entry.answer === "cancelled") return "Not answered";
  const picked = entry.request.options.find((o) => o.optionId === entry.answer);
  return picked?.name ?? entry.answer ?? "";
}

/**
 * A permission or question in the transcript: what was asked and, once answered, the answer. The
 * form to answer is pinned above the composer (`PendingRequest`).
 */
function Request({ entry }: { entry: Extract<Entry, { kind: "permission" | "elicitation" }> }) {
  const subject =
    entry.kind === "permission"
      ? (entry.request.toolCall.title ?? "a tool call")
      : entry.request.message;
  const label = entry.kind === "permission" ? "Permission" : "Question";
  return (
    <View style={styles.request} testID="chat__request">
      <Text style={styles.requestTitle}>
        {entry.answer ? `${label}: ${answerText(entry)}` : `Waiting for ${label.toLowerCase()}`}
      </Text>
      <Text style={styles.muted}>{subject}</Text>
    </View>
  );
}

function EntryView({ entry }: { entry: Entry }) {
  switch (entry.kind) {
    case "text":
      return <Markdown text={entry.text} />;
    case "thought":
      return <Thought id={entry.id} text={entry.text} />;
    case "tool":
      return <ToolCall entry={entry} />;
    case "permission":
    case "elicitation":
      return <Request entry={entry} />;
    case "file":
      return <FileView file={entry.file} />;
    case "notice":
      return (
        <Text
          style={[
            styles.notice,
            entry.level === "error" && { color: tones.failure },
            entry.level === "warning" && { color: tones.pending },
          ]}
          testID="chat__notice"
        >
          {entry.text}
        </Text>
      );
    case "failure":
      // The web shows a card; the phone shows the error line, without the appended stderr.
      return (
        <Text style={[styles.notice, { color: tones.failure }]} testID="chat__notice">
          {entry.failure.message.split("\n")[0]}
        </Text>
      );
  }
}

function time(ms: number | undefined): string {
  if (ms === undefined) return "";
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** The message's actions (Copy, when it was sent). Long-pressing the text selects it instead. */
function MessageMenu({ rowKey }: { rowKey: string }) {
  const { showActions } = useChat();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Message actions"
      onPress={() => showActions(rowKey)}
      hitSlop={10}
      style={styles.menu}
      testID="chat__message-menu"
    >
      <MoreHorizontal size={16} color={colors.mutedForeground} />
    </Pressable>
  );
}

function Body({ row }: { row: ChatRow }) {
  switch (row.kind) {
    case "user":
      return (
        <View style={styles.userWrap}>
          <View
            style={[styles.bubble, row.message.pending && styles.pending]}
            testID="chat__user-message"
          >
            {row.message.files?.map((file) => (
              <FileView key={file.url} file={file} />
            ))}
            {row.message.text.trim() ? <Markdown text={row.message.text} /> : null}
          </View>
          <MessageMenu rowKey={row.key} />
        </View>
      );
    case "part":
      return (
        <View testID="chat__assistant-part">
          {row.part.kind === "entry" ? (
            <EntryView entry={row.part.entry} />
          ) : (
            <ToolGroup id={row.part.id} tools={row.part.tools}>
              {row.part.entries.map((entry) => (
                <EntryView key={entry.id} entry={entry} />
              ))}
            </ToolGroup>
          )}
        </View>
      );
    case "footer":
      return (
        <View style={styles.footer} testID="chat__turn-end">
          <Text style={styles.footerText}>{time(row.message.createdAt)}</Text>
          <MessageMenu rowKey={row.key} />
        </View>
      );
    case "thinking":
      return (
        <View style={styles.thinking} testID="chat__thinking">
          <ActivityIndicator size="small" color={colors.mutedForeground} />
          <Text style={styles.muted}>Thinking…</Text>
        </View>
      );
  }
}

/** Whether a row shows the same thing as before, so the list can skip it while another streams. */
function sameRow(a: ChatRow, b: ChatRow): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind || a.key !== b.key) return false;
  if (a.kind === "part" && b.kind === "part") {
    const pa = a.part;
    const pb = b.part;
    if (pa.kind === "entry" && pb.kind === "entry") return pa.entry === pb.entry;
    if (pa.kind === "tools" && pb.kind === "tools") {
      return (
        pa.entries.length === pb.entries.length && pa.entries.every((e, i) => e === pb.entries[i])
      );
    }
    return false;
  }
  if (a.kind === "user" && b.kind === "user") return a.message === b.message;
  if (a.kind === "footer" && b.kind === "footer")
    return a.message.createdAt === b.message.createdAt;
  return a.kind === "thinking";
}

/**
 * One list row. The "…" button opens the message's actions (copy, and when it was sent). The row
 * has no long press of its own, because the text view's long press selects a range and the row's
 * would open the sheet on top of the selection.
 */
export const ChatRowView = memo(
  function ChatRowView({ row }: { row: ChatRow }) {
    return (
      <View style={styles.row} testID={`chat__row-${row.kind}`}>
        <Body row={row} />
      </View>
    );
  },
  (prev, next) => sameRow(prev.row, next.row),
);

const styles = StyleSheet.create({
  row: { paddingHorizontal: 16, paddingVertical: 6 },
  muted: { color: colors.mutedForeground, fontSize: 15 },
  userWrap: { alignItems: "flex-end", paddingTop: 8 },
  bubble: {
    backgroundColor: chatColors.bubble,
    borderColor: chatColors.bubbleBorder,
    borderRadius: 8,
    borderWidth: 2,
    gap: 8,
    maxWidth: "90%",
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  pending: { opacity: 0.8 },
  image: { aspectRatio: 4 / 3, borderRadius: 6, maxWidth: 280, width: "100%" },
  file: {
    backgroundColor: colors.muted,
    borderColor: colors.border,
    borderRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  fileName: { color: colors.foreground, flexShrink: 1, fontSize: 15 },
  fileType: { color: colors.mutedForeground, fontSize: 13 },
  thoughtRow: { minHeight: 28, justifyContent: "center" },
  thoughtText: {
    borderLeftColor: colors.border,
    borderLeftWidth: 2,
    color: colors.mutedForeground,
    fontSize: 14,
    lineHeight: 20,
    marginTop: 4,
    paddingLeft: 10,
  },
  request: {
    borderColor: tones.attention,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 4,
    padding: 10,
  },
  requestTitle: { color: tones.attention, fontSize: 15, fontWeight: "600" },
  notice: { color: colors.mutedForeground, fontSize: 15 },
  footer: { alignItems: "center", flexDirection: "row", gap: 10, paddingBottom: 6 },
  menu: { paddingHorizontal: 2, paddingVertical: 2 },
  footerText: { color: colors.mutedForeground, fontSize: 12 },
  thinking: { alignItems: "center", flexDirection: "row", gap: 8, paddingVertical: 4 },
});
