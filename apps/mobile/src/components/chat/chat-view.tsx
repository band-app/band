import { FlashList, type FlashListRef } from "@shopify/flash-list";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { buildRows, type ChatRow, rowType } from "../../lib/chat/rows";
import { useChatTranscript } from "../../lib/chat/use-chat";
import { useHubSession } from "../../lib/hub-session";
import { colors } from "../../theme";
import { ChatProvider } from "./chat-context";
import { ChatRowView } from "./chat-row";
import { FrameLog } from "./frame-log";
import { PlanCard } from "./plan-card";

/** Within this many points of the end counts as "at the bottom". */
const BOTTOM_SLOP = 48;

const renderRow = ({ item }: { item: ChatRow }) => <ChatRowView row={item} />;
const keyOf = (row: ChatRow) => row.key;

/**
 * One chat's transcript: history and the live turn, newest at the bottom. While the user is at
 * the bottom the list follows new output; scrolling up stops that and shows "Jump to latest".
 * Older turns load when the user reaches the top, and the list keeps its place while they do.
 */
export function ChatView({ chatId }: { chatId: string }) {
  const { hub } = useHubSession();
  const { state, loaded, loadingOlder, loadOlder } = useChatTranscript(chatId);
  const rows = useMemo(
    () => buildRows(state.messages, state.taskRunning),
    [state.messages, state.taskRunning],
  );

  const listRef = useRef<FlashListRef<ChatRow>>(null);
  const pinned = useRef(true);
  const dragging = useRef(false);
  const [showJump, setShowJump] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const onCopied = useCallback(() => {
    setCopied(true);
    clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 1500);
  }, []);

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

  const followOutput = useCallback(() => {
    if (pinned.current) listRef.current?.scrollToEnd({ animated: false });
  }, []);

  const jumpToLatest = useCallback(() => {
    pinned.current = true;
    setShowJump(false);
    listRef.current?.scrollToEnd({ animated: true });
  }, []);

  const onStartReached = useCallback(() => {
    if (state.hasOlder) void loadOlder();
  }, [state.hasOlder, loadOlder]);

  return (
    <ChatProvider hubUrl={hub.url} token={hub.token} onCopied={onCopied}>
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
        {process.env.EXPO_PUBLIC_BAND_PERF_LOG === "1" ? <FrameLog /> : null}
      </View>
      <PlanCard plan={state.plan} />
    </ChatProvider>
  );
}

const styles = StyleSheet.create({
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
