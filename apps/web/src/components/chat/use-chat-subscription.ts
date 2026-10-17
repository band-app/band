/**
 * `useChatSubscription` — one chat's read model and its actions.
 *
 * Model (issue #648):
 *   • The server is the single writer. Each chat is an event log of what
 *     crossed the chat's ACP connection: `session/update` payloads, prompts,
 *     permission and elicitation requests, turn boundaries.
 *   • One SSE stream per visible chat (`openChatStream` in
 *     `@band-app/client`). A reconnect passes the cursor and the log
 *     revision as query params for gap-fill.
 *   • The pure `transcriptReducer` folds events into render state.
 *   • `send` POSTs to `/api/chats/:chatId/messages` after showing the user's
 *     bubble optimistically; the server's `prompt` event confirms it.
 */

import { fetchChatHistory, openChatStream } from "@band-app/client/chat-stream";
import {
  type ChatMessage,
  foldEvents,
  INITIAL_TRANSCRIPT,
  type TranscriptState,
  transcriptReducer,
} from "@band-app/client/transcript";
import type { ChatEventFile, SessionState } from "@band-app/shared/chat-events";
import type { HostOfflineAnswer } from "@band-app/shared/continuation";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import { announceContinued, requestContinue } from "../../lib/continue-prompt";
import { chatFetch, directChatCall } from "../../lib/direct-chat";
import { trpc } from "../../lib/trpc-client";

export interface UseChatSubscriptionOptions {
  worktreeId: string;
  chatId: string;
  /** Pass-through to `submitTask` server-side. */
  codingAgentId?: string;
  /**
   * When `false`, the hook closes its event stream until set back to `true`
   * (e.g. a chat pane that isn't the focused tab). The state survives; the
   * next open gap-fills from the cursor.
   */
  enabled?: boolean;
}

export interface UseChatSubscriptionResult extends Pick<
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
  | "replayed"
> {
  /** True while the event stream is connected. */
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

/** Convert a browser `File` to the wire shape the server expects. */
async function fileToWirePart(file: File): Promise<ChatEventFile> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  // In 32 KB slices: one string per slice, not one per byte.
  for (let i = 0; i < bytes.byteLength; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  const mediaType = file.type || "application/octet-stream";
  return { mediaType, url: `data:${mediaType};base64,${btoa(binary)}`, filename: file.name };
}

let localId = 0;

/**
 * A stop or an answer on the chat's direct path. True when the worker took it;
 * false sends it to the hub instead (the worker does not run the chat, or is away).
 */
async function directPost(
  worktreeId: string,
  chatId: string,
  route: "stop" | "permission" | "elicitation",
  body: unknown,
): Promise<boolean> {
  const res = await directChatCall(
    worktreeId,
    chatId,
    `/api/chats/${encodeURIComponent(chatId)}/${route}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
  );
  return res?.ok === true;
}

export function useChatSubscription(opts: UseChatSubscriptionOptions): UseChatSubscriptionResult {
  const { worktreeId, chatId, codingAgentId, enabled = true } = opts;

  const [state, dispatch] = useReducer(transcriptReducer, INITIAL_TRANSCRIPT);
  const [isConnected, setIsConnected] = useState(false);

  // Tab visibility drives the event stream lifecycle. Coming back after more
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

  // Cursor and revision for every reconnect.
  const cursorRef = useRef<{ lastEventId?: number; revision: number }>({ revision: 0 });
  cursorRef.current = { lastEventId: state.lastEventId, revision: state.revision };

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!shouldBeOpen) return;
    void resumeKey;

    const stream = openChatStream({
      // This computer's worker when it runs the chat, else the hub (`lib/direct-chat.ts`).
      fetch: chatFetch(() => agentRef.current.worktreeId, chatId),
      chatId,
      getCursor: () => cursorRef.current,
      onEvent: dispatch,
      onConnection: setIsConnected,
    });
    return () => {
      stream.close();
      setIsConnected(false);
    };
  }, [chatId, shouldBeOpen, resumeKey]);

  // ---------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------

  const agentRef = useRef({ worktreeId, codingAgentId });
  agentRef.current = { worktreeId, codingAgentId };
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
        dispatch({
          type: "local-send",
          id: `pending-${++localId}`,
          text,
          files: wireFiles,
          createdAt: Date.now(),
        });
      }
      const post = (worktreeId: string) =>
        chatFetch(() => worktreeId, chatId)(`/api/chats/${encodeURIComponent(chatId)}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            worktreeId,
            text,
            ...(wireFiles && { files: wireFiles }),
            ...(agentRef.current.codingAgentId && {
              codingAgentId: agentRef.current.codingAgentId,
            }),
          }),
        });
      let res = await post(agentRef.current.worktreeId);
      if (res.status === 409) {
        // The worktree's host is offline. The hub says who could take the work, or why nobody can.
        const answer = (await res
          .clone()
          .json()
          .catch(() => null)) as HostOfflineAnswer | null;
        if (answer?.offer) {
          const continued = await requestContinue(answer, chatId);
          if (!continued) {
            const message =
              answer.code === "CONTINUE_NOT_POSSIBLE" ? answer.error : "The host is offline.";
            if (!willQueue) dispatch({ type: "local-send-failed", message });
            throw new Error(message);
          }
          // Same message, now to the chat in the worktree the work continues in.
          res = await post(continued.worktreeId);
        }
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        const message = body.error ?? `send failed: HTTP ${res.status}`;
        if (!willQueue) dispatch({ type: "local-send-failed", message });
        throw new Error(message);
      }
      // The repo continues on another host by itself: the hub moved the chat, so the UI follows.
      const sentTo = (await res
        .clone()
        .json()
        .catch(() => null)) as { worktreeId?: string; continued?: unknown } | null;
      if (sentTo?.continued && sentTo.worktreeId) announceContinued(sentTo.worktreeId);
    },
    [chatId],
  );

  const cancel = useCallback(async (): Promise<void> => {
    try {
      if (await directPost(worktreeId, chatId, "stop", {})) return;
      await trpc.tasks.abort.mutate({ worktreeId, chatId });
    } catch {
      // Nothing running; the stream already says so.
    }
  }, [worktreeId, chatId]);

  const answerPermission = useCallback(
    async (requestId: string, optionId: string | null) => {
      dispatch({ type: "local-answer", requestId, answer: optionId ?? "cancelled" });
      if (await directPost(worktreeId, chatId, "permission", { requestId, optionId })) return;
      await trpc.chat.answer.mutate({ chatId, requestId, optionId });
    },
    [chatId, worktreeId],
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
      // The same response the hub builds from these fields.
      const response = action === "accept" ? { action, content: content ?? {} } : { action };
      if (await directPost(worktreeId, chatId, "elicitation", { requestId, response })) return;
      await trpc.chat.answerElicitation.mutate({ chatId, requestId, action, content });
    },
    [chatId, worktreeId],
  );

  const setConfigOption = useCallback(
    async (configId: string, value: string) => {
      const { state: next } = await trpc.chats.setConfigOption.mutate({
        chatId,
        configId,
        value,
        worktreeId,
      });
      dispatch({ type: "session-state", state: next as SessionState, eventId: -1 });
    },
    [chatId, worktreeId],
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
      const page = await fetchChatHistory(
        chatFetch(() => agentRef.current.worktreeId, chatId),
        chatId,
        oldestEventId,
        revision,
      );
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
    replayed: state.replayed,
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
