/**
 * What the composer does to a chat, through the same calls the web chat makes
 * (`use-chat-subscription.ts`): `POST /api/chats/:id/messages` to send, `tasks.abort` to stop,
 * `chats.setConfigOption` for the model and mode, `queue.*` for queued messages.
 *
 * The hub queues a message that arrives during a turn, so `send` is the same call either way.
 */

import type { TranscriptState } from "@band-app/client/transcript";
import type { ChatEventFile, QueuedChatMessage, SessionState } from "@band-app/shared/chat-events";
import { useCallback, useRef } from "react";
import { queueSetPayload } from "../composer/queue";
import { useHubSession } from "../hub-session";
import type { ChatTranscript } from "./use-chat";

let localId = 0;

export interface ChatActions {
  send: (text: string, files?: ChatEventFile[]) => Promise<void>;
  stop: () => Promise<void>;
  setConfigOption: (configId: string, value: string) => Promise<void>;
  removeQueued: (id: string) => void;
  editQueued: (id: string, text: string) => void;
  reorderQueued: (next: QueuedChatMessage[]) => void;
}

export function useChatActions(
  worktreeId: string,
  chatId: string,
  transcript: Pick<ChatTranscript, "dispatch"> & { state: TranscriptState },
): ChatActions {
  const { client, hubFetch } = useHubSession();
  const { dispatch, state } = transcript;
  // A message sent while a turn runs or others wait goes to the queue and shows there, not as a bubble.
  const busy = useRef(false);
  busy.current = state.taskRunning || state.queue.length > 0;

  const send = useCallback(
    async (text: string, files?: ChatEventFile[]) => {
      if (!text.trim() && !files?.length) return;
      const willQueue = busy.current;
      if (!willQueue) {
        dispatch({
          type: "local-send",
          id: `pending-${++localId}`,
          text,
          files,
          createdAt: Date.now(),
        });
      }
      const res = await hubFetch(`/api/chats/${encodeURIComponent(chatId)}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ worktreeId, text, ...(files?.length ? { files } : {}) }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        const message = body.error ?? `send failed: HTTP ${res.status}`;
        if (!willQueue) dispatch({ type: "local-send-failed", message });
        throw new Error(message);
      }
    },
    [hubFetch, dispatch, chatId, worktreeId],
  );

  const stop = useCallback(async () => {
    try {
      await client.tasks.abort.mutate({ worktreeId, chatId });
    } catch {
      // Nothing running; the stream already says so.
    }
  }, [client, worktreeId, chatId]);

  const setConfigOption = useCallback(
    async (configId: string, value: string) => {
      const { state: next } = await client.chats.setConfigOption.mutate({
        chatId,
        configId,
        value,
        worktreeId,
      });
      dispatch({ type: "session-state", state: next as SessionState, eventId: -1 });
    },
    [client, dispatch, chatId, worktreeId],
  );

  const removeQueued = useCallback(
    (id: string) => {
      dispatch({
        type: "queue-updated",
        eventId: -1,
        messages: state.queue.filter((m) => m.id !== id),
      });
      void client.queue.remove.mutate({ worktreeId, chatId, id }).catch(() => {});
    },
    [client, dispatch, state.queue, worktreeId, chatId],
  );

  const editQueued = useCallback(
    (id: string, text: string) => {
      dispatch({
        type: "queue-updated",
        eventId: -1,
        messages: state.queue.map((m) => (m.id === id ? { ...m, text } : m)),
      });
      void client.queue.update.mutate({ worktreeId, chatId, id, text }).catch(() => {});
    },
    [client, dispatch, state.queue, worktreeId, chatId],
  );

  const reorderQueued = useCallback(
    (next: QueuedChatMessage[]) => {
      dispatch({ type: "queue-updated", eventId: -1, messages: next });
      void client.queue.set
        .mutate({ worktreeId, chatId, messages: queueSetPayload(next) })
        .catch(() => {});
    },
    [client, dispatch, worktreeId, chatId],
  );

  return { send, stop, setConfigOption, removeQueued, editQueued, reorderQueued };
}
