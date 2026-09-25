/**
 * `useChatSubscription` — one chat's read model and its actions.
 *
 * Model (issue #648):
 *   • The server is the single writer. Each chat is an event log of what
 *     crossed the chat's ACP connection: `session/update` payloads, prompts,
 *     permission and elicitation requests, turn boundaries.
 *   • One `EventSource` per visible chat. Native SSE auto-reconnect sends
 *     `Last-Event-ID` for gap-fill; a manual reopen passes the cursor and
 *     the log revision as query params.
 *   • The pure `transcriptReducer` folds events into render state.
 *   • `send` POSTs to `/api/chats/:chatId/messages` after showing the user's
 *     bubble optimistically; the server's `prompt` event confirms it.
 */

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { trpc } from "../../lib/trpc-client";
import {
  CHAT_EVENT_TYPES,
  type ChatEvent,
  type ChatEventFile,
  type SessionState,
} from "../../shared/chat-events";
import {
  type ChatMessage,
  foldEvents,
  INITIAL_TRANSCRIPT,
  type TranscriptState,
  transcriptReducer,
} from "./transcript";

export interface UseChatSubscriptionOptions {
  workspaceId: string;
  chatId: string;
  /** Pass-through to `submitTask` server-side. */
  codingAgentId?: string;
  /**
   * When `false`, the hook closes its EventSource until set back to `true`
   * (e.g. a chat pane that isn't the focused tab). The state survives; the
   * next open gap-fills from the cursor.
   */
  enabled?: boolean;
}

export interface UseChatSubscriptionResult
  extends Pick<
    TranscriptState,
    | "messages"
    | "status"
    | "sessionId"
    | "queue"
    | "session"
    | "plan"
    | "taskRunning"
    | "errorMessage"
    | "hasOlder"
  > {
  /** True while the EventSource is connected. */
  isConnected: boolean;
  send: (text: string, files?: File[]) => Promise<void>;
  /** Stops the running turn (`session/cancel`). */
  cancel: () => Promise<void>;
  /** Answers a `session/request_permission`; `null` cancels it. */
  answerPermission: (requestId: string, optionId: string | null) => Promise<void>;
  /** Answers a form `elicitation/create`. */
  answerElicitation: (
    requestId: string,
    action: "accept" | "decline" | "cancel",
    content?: Record<string, string | number | boolean | string[]>,
  ) => Promise<void>;
  /** Changes a session config option (model, mode, …). */
  setConfigOption: (configId: string, value: string) => Promise<void>;
  /** Prepends the turns before the oldest loaded one (issue #572). */
  loadOlder: () => Promise<void>;
  loadingOlder: boolean;
}

const MAX_BACKOFF_MS = 10_000;
const INITIAL_BACKOFF_MS = 500;

/** Convert a browser `File` to the wire shape the server expects. */
async function fileToWirePart(file: File): Promise<ChatEventFile> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  const mediaType = file.type || "application/octet-stream";
  return { mediaType, url: `data:${mediaType};base64,${btoa(binary)}`, filename: file.name };
}

let localId = 0;

export function useChatSubscription(opts: UseChatSubscriptionOptions): UseChatSubscriptionResult {
  const { workspaceId, chatId, codingAgentId, enabled = true } = opts;

  const [state, dispatch] = useReducer(transcriptReducer, INITIAL_TRANSCRIPT);
  const [isConnected, setIsConnected] = useState(false);

  // Tab visibility drives the EventSource lifecycle. Coming back after more
  // than a second hidden (iOS / PWA backgrounding kills SSE silently), a
  // BFCache restore, or going back online forces a clean reopen.
  const [docVisible, setDocVisible] = useState(() =>
    typeof document === "undefined" ? true : document.visibilityState !== "hidden",
  );
  const [resumeKey, setResumeKey] = useState(0);
  const hiddenAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVis = () => {
      const hidden = document.visibilityState === "hidden";
      if (hidden) {
        hiddenAtRef.current = Date.now();
      } else {
        const hiddenAt = hiddenAtRef.current;
        hiddenAtRef.current = null;
        if (hiddenAt !== null && Date.now() - hiddenAt > 1_000) setResumeKey((k) => k + 1);
      }
      setDocVisible(!hidden);
    };
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) setResumeKey((k) => k + 1);
    };
    const onOnline = () => setResumeKey((k) => k + 1);
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("online", onOnline);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("online", onOnline);
    };
  }, []);

  const shouldBeOpen = enabled && docVisible;

  // Cursor and revision for manual reopens. Native EventSource retries
  // carry `Last-Event-ID` on their own.
  const cursorRef = useRef<{ lastEventId?: number; revision: number }>({ revision: 0 });
  cursorRef.current = { lastEventId: state.lastEventId, revision: state.revision };

  useEffect(() => {
    if (typeof window === "undefined" || typeof EventSource === "undefined") return;
    if (!shouldBeOpen) return;
    void resumeKey;

    let cancelled = false;
    let source: EventSource | null = null;
    let retryDelay = INITIAL_BACKOFF_MS;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const offs: Array<() => void> = [];

    function open() {
      if (cancelled) return;
      const params = new URLSearchParams();
      const { lastEventId, revision } = cursorRef.current;
      if (lastEventId !== undefined) {
        params.set("lastEventId", String(lastEventId));
        params.set("revision", String(revision));
      }
      source = new EventSource(
        `/api/chats/${encodeURIComponent(chatId)}/events?${params.toString()}`,
        { withCredentials: true },
      );
      const current = source;
      const onOpen = () => {
        setIsConnected(true);
        retryDelay = INITIAL_BACKOFF_MS;
      };
      current.addEventListener("open", onOpen);
      offs.push(() => current.removeEventListener("open", onOpen));

      // Frames are `event: <type>`, so the default `message` event never
      // fires; listen per type.
      for (const type of CHAT_EVENT_TYPES) {
        const handler = (e: MessageEvent) => {
          const raw = e.data;
          if (!raw || typeof raw !== "string") return;
          try {
            dispatch(JSON.parse(raw) as ChatEvent);
          } catch (err) {
            console.error("[chat-sub] dispatch error", err);
          }
        };
        current.addEventListener(type, handler as EventListener);
        offs.push(() => current.removeEventListener(type, handler as EventListener));
      }

      const onError = () => {
        setIsConnected(false);
        // Transient errors are retried by EventSource itself. A closed
        // stream has to be reopened by hand.
        if (current.readyState === EventSource.CLOSED) {
          for (const off of offs) off();
          offs.length = 0;
          current.close();
          source = null;
          if (!cancelled) {
            retryTimer = setTimeout(open, retryDelay);
            retryDelay = Math.min(retryDelay * 2, MAX_BACKOFF_MS);
          }
        }
      };
      current.addEventListener("error", onError);
      offs.push(() => current.removeEventListener("error", onError));
    }

    open();
    return () => {
      cancelled = true;
      for (const off of offs) off();
      offs.length = 0;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      source?.close();
      source = null;
      setIsConnected(false);
    };
  }, [chatId, shouldBeOpen, resumeKey]);

  // ---------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------

  const agentRef = useRef({ workspaceId, codingAgentId });
  agentRef.current = { workspaceId, codingAgentId };
  const busyRef = useRef(false);
  busyRef.current = state.taskRunning || state.queue.length > 0;

  const send = useCallback(
    async (text: string, files?: File[]): Promise<void> => {
      if (!text.trim() && (!files || files.length === 0)) return;
      const wireFiles =
        files && files.length > 0 ? await Promise.all(files.map(fileToWirePart)) : undefined;

      // Show the bubble and the thinking indicator right away; the server's
      // `prompt` event confirms the bubble in place. A message that will be
      // queued shows up in the queue list instead.
      const willQueue = busyRef.current;
      if (!willQueue) {
        dispatch({ type: "local-send", id: `pending-${++localId}`, text, files: wireFiles });
      }
      const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/messages`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: agentRef.current.workspaceId,
          text,
          ...(wireFiles && { files: wireFiles }),
          ...(agentRef.current.codingAgentId && { codingAgentId: agentRef.current.codingAgentId }),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        const message = body.error ?? `send failed: HTTP ${res.status}`;
        if (!willQueue) dispatch({ type: "local-send-failed", message });
        throw new Error(message);
      }
    },
    [chatId],
  );

  const cancel = useCallback(async (): Promise<void> => {
    try {
      await trpc.tasks.abort.mutate({ workspaceId, chatId });
    } catch {
      // Nothing running; the stream already says so.
    }
  }, [workspaceId, chatId]);

  const answerPermission = useCallback(
    async (requestId: string, optionId: string | null) => {
      dispatch({ type: "local-answer", requestId, answer: optionId ?? "cancelled" });
      await trpc.chat.answer.mutate({ chatId, requestId, optionId });
    },
    [chatId],
  );

  const answerElicitation = useCallback(
    async (
      requestId: string,
      action: "accept" | "decline" | "cancel",
      content?: Record<string, string | number | boolean | string[]>,
    ) => {
      dispatch({
        type: "local-answer",
        requestId,
        answer: action === "cancel" ? "cancelled" : action,
      });
      await trpc.chat.answerElicitation.mutate({ chatId, requestId, action, content });
    },
    [chatId],
  );

  const setConfigOption = useCallback(
    async (configId: string, value: string) => {
      const { state: next } = await trpc.chats.setConfigOption.mutate({ chatId, configId, value });
      dispatch({ type: "session-state", state: next as SessionState, eventId: -1 });
    },
    [chatId],
  );

  // Scroll-back pagination: fetch the turns before the oldest loaded event,
  // fold them in isolation and prepend. Message ids come from event ids,
  // which are unique, so older pages never collide with loaded rows.
  const [loadingOlder, setLoadingOlder] = useState(false);
  const loadingOlderRef = useRef(false);
  const pageRef = useRef({
    hasOlder: false,
    oldestEventId: undefined as number | undefined,
    revision: 0,
  });
  pageRef.current.hasOlder = state.hasOlder;
  pageRef.current.oldestEventId = state.oldestEventId;
  pageRef.current.revision = state.revision;

  const loadOlder = useCallback(async (): Promise<void> => {
    if (loadingOlderRef.current) return;
    const { hasOlder, oldestEventId, revision } = pageRef.current;
    if (!hasOlder || !oldestEventId) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      const params = new URLSearchParams({
        before: String(oldestEventId),
        revision: String(revision),
      });
      const res = await fetch(
        `/api/chats/${encodeURIComponent(chatId)}/history?${params.toString()}`,
        { credentials: "include" },
      );
      if (!res.ok) throw new Error(`history fetch failed: HTTP ${res.status}`);
      const page = (await res.json()) as {
        events: ChatEvent[];
        hasOlder: boolean;
        oldestEventId: number;
      };
      const folded = foldEvents(INITIAL_TRANSCRIPT, page.events);
      const messages: ChatMessage[] = folded.messages;
      dispatch({
        type: "local-prepend",
        messages,
        hasOlder: page.hasOlder,
        oldestEventId: page.oldestEventId,
      });
    } catch (err) {
      console.error("[chat-sub] loadOlder failed", err);
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [chatId]);

  return {
    messages: state.messages,
    status: state.status,
    sessionId: state.sessionId,
    queue: state.queue,
    session: state.session,
    plan: state.plan,
    taskRunning: state.taskRunning,
    errorMessage: state.errorMessage,
    hasOlder: state.hasOlder,
    isConnected,
    send,
    cancel,
    answerPermission,
    answerElicitation,
    setConfigOption,
    loadOlder,
    loadingOlder,
  };
}
