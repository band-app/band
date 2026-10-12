/**
 * One chat's transcript on the phone: the same event stream and reducer the web chat uses
 * (`openChatStream` and `transcriptReducer` from `@band-app/client`), read over `expo/fetch`.
 *
 * iOS suspends a backgrounded app and drops its sockets, so the stream closes when the app
 * leaves the foreground and opens again when it returns. The reconnect sends the reducer's
 * cursor, the server replays everything after it, and the reducer drops any event it already
 * applied, so the transcript comes back with nothing missing and nothing twice.
 */

import { fetchChatHistory, openChatStream } from "@band-app/client/chat-stream";
import {
  foldEvents,
  INITIAL_TRANSCRIPT,
  type TranscriptState,
  transcriptReducer,
} from "@band-app/client/transcript";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { AppState } from "react-native";
import { useHubSession } from "../hub-session";

export interface ChatTranscript {
  state: TranscriptState;
  /** True while the event stream is open. */
  connected: boolean;
  /** True once the first replay arrived, so an empty transcript means an empty chat. */
  loaded: boolean;
  loadingOlder: boolean;
  /** Prepends the turns before the oldest loaded one. */
  loadOlder: () => Promise<void>;
}

export function useChatTranscript(chatId: string): ChatTranscript {
  const { hubFetch } = useHubSession();
  const [state, dispatch] = useReducer(transcriptReducer, INITIAL_TRANSCRIPT);
  const [connected, setConnected] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [foreground, setForeground] = useState(AppState.currentState === "active");

  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => setForeground(next === "active"));
    return () => sub.remove();
  }, []);

  const cursorRef = useRef({ lastEventId: state.lastEventId, revision: state.revision });
  cursorRef.current = { lastEventId: state.lastEventId, revision: state.revision };

  useEffect(() => {
    if (!foreground) return;
    const stream = openChatStream({
      fetch: hubFetch,
      chatId,
      getCursor: () => cursorRef.current,
      onEvent: (event) => {
        dispatch(event);
        if (event.type === "history-meta") setLoaded(true);
      },
      onConnection: setConnected,
    });
    return () => stream.close();
  }, [hubFetch, chatId, foreground]);

  const [loadingOlder, setLoadingOlder] = useState(false);
  const loadingRef = useRef(false);
  const pageRef = useRef(state);
  pageRef.current = state;

  const loadOlder = useCallback(async () => {
    const { hasOlder, oldestEventId, revision } = pageRef.current;
    if (loadingRef.current || !hasOlder || !oldestEventId) return;
    loadingRef.current = true;
    setLoadingOlder(true);
    try {
      const page = await fetchChatHistory(hubFetch, chatId, oldestEventId, revision);
      dispatch({
        type: "local-prepend",
        messages: foldEvents(INITIAL_TRANSCRIPT, page.events).messages,
        hasOlder: page.hasOlder,
        oldestEventId: page.oldestEventId,
      });
    } catch {
      // Offline or the log was rebuilt; the next scroll to the top tries again.
    } finally {
      loadingRef.current = false;
      setLoadingOlder(false);
    }
  }, [hubFetch, chatId]);

  return { state, connected, loaded, loadingOlder, loadOlder };
}
