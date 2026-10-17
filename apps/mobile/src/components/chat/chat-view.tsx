import { sessionPickers } from "@band-app/client/session-pickers";
import { FlashList, type FlashListRef } from "@shopify/flash-list";
import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  Keyboard,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { pendingRequest, requestText } from "../../lib/chat/pending-request";
import { setPending } from "../../lib/chat/pending-store";
import { buildRows, type ChatRow, rowType } from "../../lib/chat/rows";
import { useChatTranscript } from "../../lib/chat/use-chat";
import { useChatActions } from "../../lib/chat/use-chat-actions";
import { useKeyboardInset } from "../../lib/composer/use-keyboard-inset";
import { openFile } from "../../lib/files/open";
import { useHubSession } from "../../lib/hub-session";
import { colors } from "../../theme";
import { ChatProvider } from "./chat-context";
import { ChatRowView } from "./chat-row";
import { Composer } from "./composer";
import { FrameLog } from "./frame-log";
import { ListeningPill } from "./listening-pill";
import { PendingRequest } from "./pending-request";
import { PlanCard } from "./plan-card";
import { QueuedMessages } from "./queued-messages";

/** Within this many points of the end counts as "at the bottom". */
const BOTTOM_SLOP = 48;

const renderRow = ({ item }: { item: ChatRow }) => <ChatRowView row={item} />;
const keyOf = (row: ChatRow) => row.key;

/**
 * One chat's transcript: history and the live turn, newest at the bottom. While the user is at
 * the bottom the list follows new output; scrolling up stops that and shows "Jump to latest".
 * Older turns load when the user reaches the top, and the list keeps its place while they do.
 */
export const ChatView = memo(function ChatView(props: ChatViewProps) {
  // Switching session remounts the inner view, which drops the transcript and opens the stream
  // again. The hub then replays the chat's new active session, as it does on open.
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration((n) => n + 1), []);
  return <ChatViewInner key={generation} {...props} onReload={reload} />;
});

interface ChatViewProps {
  chatId: string;
  worktreeId: string;
  /** Chips shown above the composer, such as a link to the tab that needs the user. */
  chips?: ReactNode;
  /**
   * False for a chat kept mounted behind the shown one. It keeps its stream and its place, but
   * has no composer, because the worktree's draft belongs to the shown chat's composer.
   */
  active?: boolean;
}

function ChatViewInner({
  chatId,
  worktreeId,
  active = true,
  chips = null,
  onReload,
}: ChatViewProps & { onReload: () => void }) {
  const { hub, client } = useHubSession();
  const transcript = useChatTranscript(chatId);
  const { state, loaded, loadingOlder, loadOlder } = transcript;
  const actions = useChatActions(worktreeId, chatId, transcript);
  const { inset } = useKeyboardInset();
  const pickers = useMemo(() => sessionPickers(state.session), [state.session]);
  const skills = useMemo(
    () =>
      (state.session?.commands ?? []).map((c) => ({
        name: c.name,
        description: c.description,
        argumentHint: c.input && "hint" in c.input ? c.input.hint : undefined,
      })),
    [state.session?.commands],
  );
  const rows = useMemo(
    () => buildRows(state.messages, state.taskRunning),
    [state.messages, state.taskRunning],
  );

  // Same calls as the web: queued messages belong to the session they were queued against, then
  // the active session is set. Like the web, a running turn is not asked about first.
  const switchSession = useCallback(
    async (sessionId: string | undefined, summary?: string) => {
      await client.queue.clear.mutate({ worktreeId, chatId }).catch(() => {});
      await client.chats.setActiveSession.mutate({ worktreeId, chatId, sessionId, summary });
      onReload();
    },
    [client, worktreeId, chatId, onReload],
  );
  const sessions = useMemo(
    () => ({ worktreeId, chatId, currentSessionId: state.sessionId, onSwitch: switchSession }),
    [worktreeId, chatId, state.sessionId, switchSession],
  );

  const request = useMemo(() => pendingRequest(state.messages), [state.messages]);
  // The tab sheet shows the question as this chat's summary.
  const requestLine = request ? requestText(request) : null;
  useEffect(() => {
    setPending(chatId, requestLine);
  }, [chatId, requestLine]);
  useEffect(() => () => setPending(chatId, null), [chatId]);

  const listRef = useRef<FlashListRef<ChatRow>>(null);
  const pinned = useRef(true);
  const dragging = useRef(false);
  const [showJump, setShowJump] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(copiedTimer.current), []);

  const onCopied = useCallback(() => {
    setCopied(true);
    clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 1500);
  }, []);

  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const rowFor = useCallback((key: string) => rowsRef.current.find((r) => r.key === key), []);

  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    // Only the user moves the pin; the list's own scrolls (following output, keeping its place
    // while older turns load) don't.
    if (!dragging.current) return;
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const atBottom =
      contentSize.height - (contentOffset.y + layoutMeasurement.height) < BOTTOM_SLOP;
    pinned.current = atBottom;
    setShowJump(!atBottom);
  }, []);

  // Opening a tool call or a thought grows the content too. Following that would push what the
  // user just opened above the screen, so the list follows again only once new output arrives.
  const toggled = useRef(false);
  const onToggle = useCallback(() => {
    toggled.current = true;
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new `rows` is the trigger
  useEffect(() => {
    toggled.current = false;
  }, [rows]);

  const followOutput = useCallback(() => {
    if (pinned.current && !toggled.current) listRef.current?.scrollToEnd({ animated: false });
  }, []);

  // The keyboard shortens the list. Keep the last message in view when it was in view before.
  useEffect(() => {
    const sub = Keyboard.addListener("keyboardDidShow", followOutput);
    return () => sub.remove();
  }, [followOutput]);

  const jumpToLatest = useCallback(() => {
    pinned.current = true;
    setShowJump(false);
    listRef.current?.scrollToEnd({ animated: true });
  }, []);

  const onStartReached = useCallback(() => {
    if (state.hasOlder) void loadOlder();
  }, [state.hasOlder, loadOlder]);

  return (
    <ChatProvider
      hubUrl={hub.url}
      token={hub.token}
      onCopied={onCopied}
      onToggle={onToggle}
      rowFor={rowFor}
      onOpenFile={(path) => {
        // A path the agent wrote may end in `:line` or `:line:column`.
        const at = /^(.*?):(\d+)(?::\d+)?$/.exec(path);
        openFile(worktreeId, at ? at[1] : path, at ? Number(at[2]) : undefined);
      }}
    >
      <Animated.View style={[styles.keyboard, { paddingBottom: inset }]}>
        <View style={styles.root} testID="chat__view">
          {!loaded ? (
            <View style={styles.center} testID="chat__loading">
              <ActivityIndicator color={colors.mutedForeground} />
            </View>
          ) : rows.length === 0 ? (
            <View style={styles.center}>
              <Text style={styles.muted} testID="chat__empty">
                No messages yet.
              </Text>
            </View>
          ) : (
            <FlashList
              ref={listRef}
              data={rows}
              renderItem={renderRow}
              keyExtractor={keyOf}
              getItemType={rowType}
              initialScrollIndex={rows.length - 1}
              maintainVisibleContentPosition={{ startRenderingFromBottom: true }}
              onStartReached={onStartReached}
              onStartReachedThreshold={0.5}
              onScroll={onScroll}
              scrollEventThrottle={32}
              onScrollBeginDrag={() => {
                dragging.current = true;
              }}
              onMomentumScrollEnd={() => {
                dragging.current = false;
              }}
              onScrollEndDrag={(e) => {
                // Without momentum the drag is the whole scroll.
                if ((e.nativeEvent.velocity?.y ?? 0) === 0) dragging.current = false;
              }}
              onContentSizeChange={followOutput}
              ListHeaderComponent={
                loadingOlder ? (
                  <View style={styles.older} testID="chat__loading-older">
                    <ActivityIndicator size="small" color={colors.mutedForeground} />
                  </View>
                ) : null
              }
              contentContainerStyle={styles.content}
              keyboardDismissMode="interactive"
              keyboardShouldPersistTaps="handled"
              testID="chat__list"
            />
          )}
          {showJump ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Jump to latest"
              onPress={jumpToLatest}
              style={styles.jump}
              testID="chat__jump-latest"
            >
              <Text style={styles.jumpText}>↓ Jump to latest</Text>
            </Pressable>
          ) : null}
          {copied ? (
            <View style={styles.toast} pointerEvents="none" testID="chat__copied">
              <Text style={styles.toastText}>Copied</Text>
            </View>
          ) : null}
          <ListeningPill chatId={chatId} />
          {process.env.EXPO_PUBLIC_BAND_PERF_LOG === "1" ? <FrameLog /> : null}
        </View>
        {request ? (
          <PendingRequest
            entry={request}
            onAnswerPermission={actions.answerPermission}
            onAnswerElicitation={actions.answerElicitation}
          />
        ) : null}
        <PlanCard plan={state.plan} />
        {active ? chips : null}
        <QueuedMessages
          messages={state.queue}
          onRemove={actions.removeQueued}
          onEdit={actions.editQueued}
          onReorder={actions.reorderQueued}
        />
        {active && request?.kind !== "elicitation" ? (
          <Composer
            worktreeId={worktreeId}
            running={state.taskRunning}
            skills={skills}
            pickers={pickers}
            setConfigOption={actions.setConfigOption}
            sessions={sessions}
            onSend={actions.send}
            onStop={() => void actions.stop()}
          />
        ) : null}
      </Animated.View>
    </ChatProvider>
  );
}

const styles = StyleSheet.create({
  keyboard: { flex: 1 },
  root: { flex: 1 },
  center: { alignItems: "center", flex: 1, justifyContent: "center" },
  muted: { color: colors.mutedForeground, fontSize: 15 },
  content: { paddingBottom: 12, paddingTop: 8 },
  older: { alignItems: "center", paddingVertical: 12 },
  jump: {
    alignSelf: "center",
    backgroundColor: colors.muted,
    borderColor: colors.border,
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    bottom: 12,
    paddingHorizontal: 14,
    paddingVertical: 8,
    position: "absolute",
  },
  jumpText: { color: colors.foreground, fontSize: 14, fontWeight: "600" },
  toast: {
    alignSelf: "center",
    backgroundColor: colors.foreground,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 6,
    position: "absolute",
    top: 12,
  },
  toastText: { color: colors.background, fontSize: 14, fontWeight: "600" },
});
