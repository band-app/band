import { REVIEW_LABEL, relativeTime } from "@band-app/client/merge";
import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react-native";
import { useState } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { colors } from "../../theme";
import { ChatProvider } from "../chat/chat-context";
import { Markdown, PlainTextContext } from "../chat/markdown";

/** The parts of the hub's `ReviewDiscussion` this view reads. */
interface Comment {
  id: string;
  author: { login: string };
  body: string;
  createdAt: string;
  url: string | null;
}
interface Item extends Comment {
  kind: "comment" | "review";
  reviewState?: keyof typeof REVIEW_LABEL;
}
interface Thread {
  id: string;
  path: string;
  line: number | null;
  isResolved: boolean;
  isOutdated: boolean;
  comments: Comment[];
  truncated?: boolean;
}
export interface Discussion {
  items: Item[];
  threads: Thread[];
  truncated?: boolean;
}

function openUrl(url: string) {
  if (/^https?:\/\//.test(url)) void Linking.openURL(url).catch(() => {});
}

/** The pull request's conversation, review summaries and inline threads, oldest first. */
export function DiscussionSection({
  discussion,
  hub,
}: {
  discussion: Discussion;
  hub: { url: string; token: string };
}) {
  const total = discussion.items.length + discussion.threads.length;
  const unresolved = discussion.threads.filter((t) => !t.isResolved).length;
  const summary =
    total === 0
      ? "none"
      : `${total}${discussion.threads.length > 0 ? `, ${unresolved} unresolved` : ""}`;
  const entries = [
    ...discussion.items.map((item) => ({
      key: item.id,
      at: item.createdAt,
      node: <ConversationItem key={item.id} item={item} />,
    })),
    ...discussion.threads.map((thread) => ({
      key: thread.id,
      at: thread.comments[0]?.createdAt ?? "",
      node: <ThreadView key={thread.id} thread={thread} />,
    })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  return (
    // Comment bodies are markdown rendered by the chat's component, which reads this context.
    <ChatProvider
      hubUrl={hub.url}
      token={hub.token}
      onCopied={() => {}}
      onToggle={() => {}}
      rowFor={() => undefined}
    >
      <PlainTextContext.Provider value>
        <View style={styles.section} testID="pr-comments">
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Comments</Text>
            <Text style={styles.sectionSummary} testID="pr-comments__summary">
              {summary}
            </Text>
          </View>
          {entries.length === 0 ? (
            <Text style={styles.empty} testID="pr-comments__empty">
              No comments yet.
            </Text>
          ) : (
            entries.map((entry) => entry.node)
          )}
          {discussion.truncated ? (
            <Text style={styles.empty} testID="pr-comments__more">
              Older comments are on GitHub.
            </Text>
          ) : null}
        </View>
      </PlainTextContext.Provider>
    </ChatProvider>
  );
}

function ConversationItem({ item }: { item: Item }) {
  const verb = item.kind === "review" && item.reviewState ? REVIEW_LABEL[item.reviewState] : null;
  return (
    <View style={styles.message} testID="pr-comments__item">
      <MessageHeader comment={item} verb={verb} />
      {item.body.trim() ? <Markdown text={item.body} /> : null}
    </View>
  );
}

function ThreadView({ thread }: { thread: Thread }) {
  const label = thread.isResolved ? "Resolved" : thread.isOutdated ? "Outdated" : null;
  const [open, setOpen] = useState(label === null);
  const location = thread.line ? `${thread.path}:${thread.line}` : thread.path;
  return (
    <View style={styles.thread} testID="pr-comments__thread">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${open ? "Collapse" : "Expand"} thread ${location}`}
        onPress={() => setOpen((v) => !v)}
        style={styles.threadHeader}
        testID="pr-comments__thread-toggle"
      >
        {open ? (
          <ChevronDown size={16} color={colors.mutedForeground} />
        ) : (
          <ChevronRight size={16} color={colors.mutedForeground} />
        )}
        <Text style={styles.location} numberOfLines={1} testID="pr-comments__thread-location">
          {location}
        </Text>
        {label ? (
          <View style={styles.tag}>
            <Text style={styles.tagText} testID="pr-comments__thread-label">
              {label}
            </Text>
          </View>
        ) : null}
      </Pressable>
      {open ? (
        <View style={styles.threadBody}>
          {thread.comments.map((comment) => (
            <View key={comment.id} style={styles.reply} testID="pr-comments__message">
              <MessageHeader comment={comment} verb={null} />
              {comment.body.trim() ? <Markdown text={comment.body} /> : null}
            </View>
          ))}
          {thread.truncated ? <Text style={styles.empty}>More replies on GitHub.</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

function MessageHeader({ comment, verb }: { comment: Comment; verb: string | null }) {
  return (
    <View style={styles.header}>
      <Text style={styles.author} numberOfLines={1} testID="pr-comments__author">
        {comment.author.login}
      </Text>
      {verb ? <Text style={styles.meta}>{verb}</Text> : null}
      <Text style={styles.meta} testID="pr-comments__time">
        {relativeTime(comment.createdAt)}
      </Text>
      {comment.url ? (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel="Open comment on GitHub"
          hitSlop={8}
          onPress={() => openUrl(comment.url as string)}
          style={styles.link}
          testID="pr-comments__link"
        >
          <ExternalLink size={15} color={colors.mutedForeground} />
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: 8 },
  sectionHeader: {
    alignItems: "baseline",
    borderBottomColor: colors.divider,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  sectionTitle: { color: colors.foreground, fontSize: 15, fontWeight: "600" },
  sectionSummary: { color: colors.mutedForeground, fontSize: 13 },
  empty: {
    color: colors.mutedForeground,
    fontSize: 13,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  message: {
    borderBottomColor: colors.divider,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 4,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  header: { alignItems: "center", flexDirection: "row", gap: 8 },
  author: { color: colors.foreground, flexShrink: 1, fontSize: 14, fontWeight: "600" },
  meta: { color: colors.mutedForeground, fontSize: 12 },
  link: { marginLeft: "auto" },
  thread: {
    borderBottomColor: colors.divider,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  threadHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: 8,
    minHeight: 44,
    paddingHorizontal: 16,
  },
  location: { color: colors.foreground, flex: 1, fontFamily: "Menlo", fontSize: 12 },
  tag: {
    backgroundColor: colors.card,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  tagText: { color: colors.mutedForeground, fontSize: 11 },
  threadBody: { paddingLeft: 16 },
  reply: { gap: 4, paddingHorizontal: 16, paddingVertical: 8 },
});
