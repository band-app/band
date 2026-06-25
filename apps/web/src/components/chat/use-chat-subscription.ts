/**
 * `useChatSubscription` — the single client-side hook owning one chat's
 * read model + submit affordance.
 *
 * Replaces the entire orchestration layer in the old `ChatView`:
 * `useChat` from `@ai-sdk/react`, `TaskChatTransport`, `sessionIdRef`,
 * `lastEventIdRef`, `connectAbortRef`, the 5-step backoff retry, the
 * focus/online/visibility/wsActive plumbing, `loadMessages`, the
 * `serverTaskRunning` optimistic flag, and the `connectToRunningStream`
 * loop. All gone.
 *
 * Model:
 *   • Server is the single writer. The chat is an event log.
 *   • One `EventSource` per visible chat. Native SSE auto-reconnect uses
 *     `Last-Event-ID` for gap-fill.
 *   • Pure reducer (`chatEventReducer`) folds events into render state.
 *   • `send(text, files)` POSTs to `/api/chats/:chatId/messages`. The
 *     server's `user-message` echo arrives over the open subscription
 *     within milliseconds — no optimistic state needed.
 *   • `cancel()` aborts the running task via the existing tRPC route.
 *
 * What the hook explicitly does NOT do:
 *   • Reach for `useChat` from the AI SDK.
 *   • Manage a separate "session id" ref — the reducer's `sessionId`
 *     field is derived from `session-resolved` events.
 *   • Pre-flight any HTTP call before send.
 *   • Probe `tasks.isRunning` or `tasks.get`.
 *   • Reload history via a separate tRPC `messages` query — JSONL
 *     backfill is part of the subscription replay.
 *
 * If a bug appears that would have required one of those workarounds in
 * the old model, it's a hint the server's event log is missing data —
 * fix it at the source, not by re-introducing client orchestration.
 */

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { trpc } from "../../lib/trpc-client";
import {
  CHAT_EVENT_TYPES,
  type ChatEvent,
  type ChatEventFile,
  HISTORY_PAGE_SIZE,
} from "../../shared/chat-events";
import {
  applyEvents,
  type ChatSubscriptionState,
  chatEventReducer,
  INITIAL_STATE,
} from "./chat-event-reducer";

export interface UseChatSubscriptionOptions {
  workspaceId: string;
  chatId: string;
  /** Pass-through to `submitTask` server-side. */
  mode?: string;
  /** Pass-through to `submitTask` server-side. */
  model?: string;
  /** Pass-through to `submitTask` server-side. */
  codingAgentId?: string;
  /**
   * When `false`, the hook closes the underlying EventSource and stops
   * reconnecting until set back to `true`. Used by hosts that have their
   * own visibility / "active pane" notion — e.g. dockview-managed chat
   * panes that should release their connection slot while not the
   * focused tab. Defaults to `true`.
   *
   * The reducer state is preserved across the disabled → enabled
   * transition; the next open call passes `lastEventId` so the server
   * gap-fills any events the client missed.
   */
  enabled?: boolean;
}

export interface UseChatSubscriptionResult
  extends Omit<
    ChatSubscriptionState,
    | "currentAssistantId"
    | "lastEventId"
    | "messageIdCounter"
    | "pendingOptimisticTask"
    | "oldestOffset"
    | "pendingToolOutputs"
  > {
  /** True while the EventSource is connected to the server. */
  isConnected: boolean;
  /** Submit a new user message. Resolves once the server has accepted the
   *  POST; the user-message bubble appears via the subscription's
   *  `user-message` event a few ms later. */
  send: (text: string, files?: File[]) => Promise<void>;
  /** Abort the currently running task. No-op if nothing is running. */
  cancel: () => Promise<void>;
  /** Fetch the page of messages immediately older than the ones currently
   *  held and prepend them. No-op when there's nothing older or a fetch is
   *  already in flight. Drives scroll-back pagination (issue #572). */
  loadOlder: () => Promise<void>;
  /** True while a `loadOlder()` fetch is in flight. */
  loadingOlder: boolean;
}

/** Older-page size requested by `loadOlder` — the shared window size. */
const OLDER_PAGE_LIMIT = HISTORY_PAGE_SIZE;

// Max backoff for reconnect attempts. Native EventSource does its own
// retry; this kicks in when we close-and-reopen manually (server
// terminated the stream on task-completed, or a fetch error).
const MAX_BACKOFF_MS = 10_000;
const INITIAL_BACKOFF_MS = 500;

/** Convert a browser `File` to the wire shape the server expects. */
async function fileToWirePart(file: File): Promise<ChatEventFile> {
  const buffer = await file.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  const base64 =
    typeof btoa !== "undefined" ? btoa(binary) : Buffer.from(buffer).toString("base64");
  return {
    mediaType: file.type || "application/octet-stream",
    url: `data:${file.type || "application/octet-stream"};base64,${base64}`,
    filename: file.name,
  };
}

export function useChatSubscription(opts: UseChatSubscriptionOptions): UseChatSubscriptionResult {
  const { workspaceId, chatId, mode, model, codingAgentId, enabled = true } = opts;

  const [state, dispatch] = useReducer(chatEventReducer, INITIAL_STATE);
  const [isConnected, setIsConnected] = useState(false);

  // Tab visibility — drives the EventSource open/close lifecycle.
  const [docVisible, setDocVisible] = useState(() =>
    typeof document === "undefined" ? true : document.visibilityState !== "hidden",
  );

  // Bumped on every "we just came back to the foreground after being gone
  // long enough that the connection might be dead" signal. Used as a
  // dependency of the EventSource effect so each bump forces a clean
  // teardown + reopen. The signals we treat as "long enough":
  //
  //   • `visibilitychange` to visible after being hidden for > 1 second
  //     (iOS Safari / PWA app-backgrounding case — JS suspends, SSE dies
  //     silently, no error event ever fires when the page resumes).
  //   • `pageshow` with `event.persisted === true` (BFCache restore on
  //     mobile browsers — every connection is dead at this point).
  //   • `online` (network restored after offline gap).
  //
  // Plain focus / blur is intentionally NOT treated as a resume signal:
  // it fires on every tab switch within the same browser session and
  // would cause noisy reconnects.
  const [resumeKey, setResumeKey] = useState(0);
  const hiddenAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const HIDE_FORCE_RECONNECT_MS = 1_000;

    const onVis = () => {
      const hidden = document.visibilityState === "hidden";
      if (hidden) {
        hiddenAtRef.current = Date.now();
      } else {
        const hiddenAt = hiddenAtRef.current;
        hiddenAtRef.current = null;
        if (hiddenAt !== null && Date.now() - hiddenAt > HIDE_FORCE_RECONNECT_MS) {
          setResumeKey((k) => k + 1);
        }
      }
      setDocVisible(!hidden);
    };
    const onPageShow = (e: PageTransitionEvent) => {
      // BFCache restore — the page was frozen and is now thawing. Every
      // network connection from the old tab is dead.
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

  // Track the last event id we've successfully applied so a manual
  // close-and-reopen (after the server explicitly closes on
  // `task-completed`) re-attaches with the right cursor. Native
  // EventSource handles `Last-Event-ID` internally during its own
  // auto-retries — this ref is just for the close-then-reopen case.
  const lastEventIdRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (state.lastEventId != null) {
      lastEventIdRef.current = state.lastEventId;
    }
  }, [state.lastEventId]);

  // Stable refs to the latest send/cancel context so the EventSource
  // effect doesn't have to re-open on every mode/model change.
  const optsRef = useRef({ workspaceId, mode, model, codingAgentId });
  useEffect(() => {
    optsRef.current = { workspaceId, mode, model, codingAgentId };
  }, [workspaceId, mode, model, codingAgentId]);

  // ---------------------------------------------------------------------
  // EventSource lifecycle
  //
  // One `EventSource` per (chatId). Reopens on chatId change. Backs off
  // exponentially on close-and-reopen cycles. Closed cleanly on unmount.
  // ---------------------------------------------------------------------
  useEffect(() => {
    if (typeof window === "undefined" || typeof EventSource === "undefined") return;
    if (!shouldBeOpen) return; // host disabled us, or tab hidden
    // `resumeKey` is referenced here so it shows up as a "read" inside
    // the effect and biome doesn't flag the dep as unnecessary. The
    // effect itself doesn't care about the value — the dep change is the
    // signal to tear down + reopen on app resume. See the resume-signals
    // effect above.
    void resumeKey;

    let cancelled = false;
    let source: EventSource | null = null;
    let retryDelay = INITIAL_BACKOFF_MS;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const listeners: Array<() => void> = [];

    function open() {
      if (cancelled) return;

      const params = new URLSearchParams();
      // Pass workspaceId so the server can do JSONL backfill even when
      // the chat row doesn't have it yet (cold subscribe to a chat that's
      // never had a task in this server process).
      params.set("workspaceId", optsRef.current.workspaceId);
      if (lastEventIdRef.current != null) {
        params.set("lastEventId", String(lastEventIdRef.current));
      }
      const url = `/api/chats/${encodeURIComponent(chatId)}/events?${params.toString()}`;

      source = new EventSource(url, { withCredentials: true });

      const onOpen = () => {
        setIsConnected(true);
        retryDelay = INITIAL_BACKOFF_MS;
      };
      source.addEventListener("open", onOpen);
      listeners.push(() => source?.removeEventListener("open", onOpen));

      // We emit `event: <type>` per ChatEvent on the wire — the default
      // `message` event never fires. Listen for each known type.
      for (const evtType of CHAT_EVENT_TYPES) {
        const handler = (e: MessageEvent) => {
          // EventSource can deliver synthetic empty messages on certain
          // close-then-reconnect transitions. Drop anything that isn't
          // valid JSON rather than warn — these never carry useful data.
          const raw = e.data;
          if (!raw || typeof raw !== "string" || raw === "undefined") return;
          try {
            const data = JSON.parse(raw) as ChatEvent;
            // EventSource auto-sets `e.lastEventId`, but our reducer reads
            // the eventId off the payload. Trust the payload value.
            dispatch(data);
          } catch (err) {
            console.error("[chat-sub] dispatch error", err);
          }
        };
        source.addEventListener(evtType, handler as EventListener);
        const captured = source;
        listeners.push(() => captured.removeEventListener(evtType, handler as EventListener));
      }

      const onError = () => {
        setIsConnected(false);
        // Native EventSource will retry on its own for transient errors
        // (status field stays `CONNECTING`). When the server explicitly
        // closes the stream after `task-completed`, readyState becomes
        // `CLOSED` and we must manually reopen — that's the path we
        // schedule here.
        if (source && source.readyState === EventSource.CLOSED) {
          for (const off of listeners) off();
          listeners.length = 0;
          source.close();
          source = null;
          if (!cancelled) {
            retryTimer = setTimeout(open, retryDelay);
            retryDelay = Math.min(retryDelay * 2, MAX_BACKOFF_MS);
          }
        }
      };
      source.addEventListener("error", onError);
      listeners.push(() => source?.removeEventListener("error", onError));
    }

    open();

    return () => {
      cancelled = true;
      for (const off of listeners) off();
      listeners.length = 0;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      source?.close();
      source = null;
      setIsConnected(false);
    };
    // `resumeKey` forces a clean teardown + reopen each time the app
    // comes back from background / BFCache / offline (see the
    // resume-signals effect above). Without this, the existing
    // EventSource may sit on a half-dead TCP connection that never fires
    // `error` — events are silently lost until the next tab focus.
  }, [chatId, shouldBeOpen, resumeKey]);

  // ---------------------------------------------------------------------
  // send / cancel
  // ---------------------------------------------------------------------
  const send = useCallback(
    async (text: string, files?: File[]): Promise<void> => {
      const trimmed = text.trim();
      if (!trimmed && (!files || files.length === 0)) return;

      const filesPayload =
        files && files.length > 0 ? await Promise.all(files.map(fileToWirePart)) : undefined;

      // Optimistic state BEFORE the POST. The server's real `user-message`
      // event is emitted AFTER session-start, which can be 1-2 seconds in
      // on a cold agent boot. Without optimistic state the user types,
      // hits send, and stares at an idle UI before either their bubble
      // OR the thinking indicator appear — exactly the latency #478 set
      // out to fix.
      //
      // Two events are dispatched together so they batch into a single
      // React render:
      //
      //   1. `user-message` — adds the user bubble. Synthetic negative
      //      eventId signals "pending"; the reducer matches the real
      //      echo by text and replaces the pending bubble in place.
      //
      //   2. `task-started` — flips `taskRunning` + `status: "submitting"`
      //      so `isStreaming` becomes true → ThinkingIndicator shows
      //      immediately. Both reducer cases are idempotent: when the
      //      real events arrive over the subscription, re-applying them
      //      lands on the same state.
      //
      // Only fires when the message will actually be sent (no running
      // task, no queue). If it would be queued, the server's
      // `queue-updated` event handles the visual within ms; adding a
      // pending bubble here would double-render the same message in the
      // main chat AND the queue list, and `taskRunning` is already true
      // anyway.
      const willBeQueued = state.taskRunning || state.queuedMessages.length > 0;
      const optimisticEventId = willBeQueued ? 0 : -Date.now();
      if (!willBeQueued) {
        dispatch({
          type: "user-message",
          text,
          ...(filesPayload && filesPayload.length > 0 && { files: filesPayload }),
          eventId: optimisticEventId,
        });
        dispatch({
          type: "task-started",
          taskId: `pending-${-optimisticEventId}`,
          eventId: optimisticEventId - 1,
        });
      }

      const body = {
        workspaceId: optsRef.current.workspaceId,
        text,
        ...(filesPayload && filesPayload.length > 0 && { files: filesPayload }),
        ...(optsRef.current.mode && { mode: optsRef.current.mode }),
        ...(optsRef.current.model && { model: optsRef.current.model }),
        ...(optsRef.current.codingAgentId && { codingAgentId: optsRef.current.codingAgentId }),
      };

      const res = await fetch(`/api/chats/${encodeURIComponent(chatId)}/messages`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as { error?: string };
        // Roll back the optimistic task-started so the thinking indicator
        // doesn't spin forever after a failed submit. The pending user
        // bubble stays in place so the user can see what they tried to
        // send. Surfaces as `status: "error"` via the reducer.
        if (!willBeQueued) {
          dispatch({
            type: "task-error",
            taskId: `pending-${-optimisticEventId}`,
            message: errBody.error ?? `send failed: HTTP ${res.status}`,
            eventId: optimisticEventId - 2,
          });
        }
        throw new Error(errBody.error ?? `send failed: HTTP ${res.status}`);
      }
      // No client-side state mutation here. The server's `user-message` event
      // arrives over the open subscription a few ms later; the reducer
      // appends the message to `state.messages` from there.
    },
    [chatId, state.taskRunning, state.queuedMessages.length],
  );

  const cancel = useCallback(async (): Promise<void> => {
    try {
      await trpc.tasks.abort.mutate({ workspaceId, chatId });
    } catch {
      // Aborting a not-running task is fine — surfaces as a "no running
      // task" tRPC error which we swallow here. The subscription's
      // `task-error` event handles the user-visible state.
    }
  }, [workspaceId, chatId]);

  // ---------------------------------------------------------------------
  // Scroll-back pagination (issue #572)
  //
  // The cold subscribe replays only the most recent window and emits a
  // `history-meta` event recording `hasOlder` + `oldestOffset`. When the
  // user scrolls to the top, `ChatView` calls `loadOlder()`, which fetches
  // the page immediately preceding what we hold, folds it through a FRESH
  // reducer in isolation (so the page's tool pairs resolve internally), then
  // dispatches a `prepend-messages` action. Folding in isolation + id
  // re-namespacing is what keeps existing message ids — and therefore the
  // virtualizer's measured DOM rows — stable across the prepend.
  // ---------------------------------------------------------------------
  const [loadingOlder, setLoadingOlder] = useState(false);
  const loadingOlderRef = useRef(false);
  // The pagination cursor is read through a ref so `loadOlder`'s identity stays
  // stable across page loads. If it depended on `state.oldestOffset`/`hasOlder`
  // directly, every `prepend-messages` dispatch would mint a new callback and
  // tear down + re-attach the IntersectionObserver in `ChatView` on each load.
  const paginationRef = useRef({
    hasOlder: state.hasOlder,
    oldestOffset: state.oldestOffset,
    sessionId: state.sessionId,
  });
  paginationRef.current = {
    hasOlder: state.hasOlder,
    oldestOffset: state.oldestOffset,
    sessionId: state.sessionId,
  };
  const loadOlder = useCallback(async (): Promise<void> => {
    // The IntersectionObserver fires repeatedly while the sentinel is in
    // view; the ref guard collapses those into a single in-flight fetch.
    if (loadingOlderRef.current) return;
    const { hasOlder, oldestOffset, sessionId } = paginationRef.current;
    const before = oldestOffset;
    if (!hasOlder || before == null || before <= 0 || !sessionId) return;

    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      // Only the cursor is sent. The server resolves session + workspace from
      // the chat row (never a client param) to avoid a path-traversal sink —
      // see `chat-history.ts`. The `state.sessionId` guard above just gates the
      // fetch until a session has actually resolved.
      const params = new URLSearchParams();
      params.set("before", String(before));
      params.set("limit", String(OLDER_PAGE_LIMIT));
      const res = await fetch(
        `/api/chats/${encodeURIComponent(chatId)}/history?${params.toString()}`,
        { credentials: "include" },
      );
      if (!res.ok) throw new Error(`history fetch failed: HTTP ${res.status}`);
      const data = (await res.json()) as {
        events: ChatEvent[];
        hasOlder: boolean;
        oldestOffset: number;
      };

      // Fold the page in isolation to build its UIMessages, then namespace the
      // top-level message ids so they can't collide with the live set or with
      // an earlier page (`before` strictly decreases per page). `toolCallId`s
      // and text-part ids are left intact so the reducer's orphan-output buffer
      // still matches across the page boundary.
      const folded = applyEvents(INITIAL_STATE, data.events);
      const namespaced = folded.messages.map((m) => ({ ...m, id: `o${before}-${m.id}` }));

      dispatch({
        type: "prepend-messages",
        messages: namespaced,
        hasOlder: data.hasOlder,
        oldestOffset: data.oldestOffset,
        // Carry forward any outputs the page couldn't resolve internally (their
        // tool_use is in an even-older page) so a later load resolves them.
        pendingToolOutputs: folded.pendingToolOutputs,
      });
    } catch (err) {
      console.error("[chat-sub] loadOlder failed", err);
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
    // Cursor + session read via `paginationRef`, so the only real dependency is
    // `chatId` — keeps the callback identity stable across page loads.
  }, [chatId]);

  return {
    messages: state.messages,
    status: state.status,
    sessionId: state.sessionId,
    queuedMessages: state.queuedMessages,
    usage: state.usage,
    taskRunning: state.taskRunning,
    taskErrorMessage: state.taskErrorMessage,
    hasOlder: state.hasOlder,
    isConnected,
    send,
    cancel,
    loadOlder,
    loadingOlder,
  };
}
