/**
 * Pure reducer mapping `ChatEvent` stream → render state.
 *
 * This is the heart of the new chat-event-log model:
 *
 *   • Server is the single writer. It broadcasts a totally-ordered event log.
 *   • Client subscribes and applies events through this reducer to derive the
 *     full render state (messages, status, queue, usage, sessionId).
 *   • No optimistic state. No multiple-sources-of-truth reconciliation.
 *   • Pure (no I/O, no Date.now(), no Math.random()) — every test fixture is
 *     deterministic.
 *
 * The output `messages` array is shape-compatible with the AI SDK's
 * `UIMessage` so existing render code in `ChatView.tsx` keeps working.
 */

import type { UIMessage } from "ai";
import type {
  ChatEvent,
  ChatEventUsage,
  QueuedChatMessage,
  ToolInputAvailableEvent,
  ToolOutputAvailableEvent,
} from "../../shared/chat-events";

export type ChatStatus = "idle" | "submitting" | "streaming" | "completed" | "error";

export interface ChatSubscriptionState {
  /** Render-ready conversation. Stable order: oldest → newest. */
  messages: UIMessage[];
  /** Lifecycle state of the *current* (most recent) task. */
  status: ChatStatus;
  /** Latest session id reported by the server (`session-resolved` event). */
  sessionId: string | undefined;
  /** Server-owned queue of pending user messages. */
  queuedMessages: QueuedChatMessage[];
  /** Latest token-usage snapshot, if any. */
  usage: ChatEventUsage | undefined;
  /** Highest `eventId` applied — used by the client to set `Last-Event-ID`. */
  lastEventId: number | undefined;
  /** True if the server-side task is currently running. Driven exclusively
   *  by `task-started` / `task-completed` / `task-error` events. */
  taskRunning: boolean;
  /** Last task-level error message, if any. Cleared on the next
   *  `task-started`. Surfaces things like agent crashes or aborts. */
  taskErrorMessage: string | undefined;
  /** Internal: id of the assistant message currently accumulating parts.
   *  Set on the first text/tool event after a `user-message`; cleared on
   *  `task-completed` / `task-error`. */
  currentAssistantId: string | undefined;
  /** Internal: monotonic counter for assigning *globally unique* message
   *  ids. The server's eventIds are unique per session buffer only — JSONL
   *  replay paging in multiple sessions emits colliding eventIds (every
   *  session's `user-message` is eventId=2). React would complain about
   *  duplicate keys without this. */
  messageIdCounter: number;
  /** Internal: true while the current `taskRunning: true` originated from an
   *  UNACKNOWLEDGED optimistic `send()` (a synthetic `task-started` with a
   *  negative eventId), and the server hasn't confirmed it yet with a real
   *  (positive-eventId) `task-started` / `task-completed` / `task-error`.
   *
   *  This is the one window in which `subscription-opened` must NOT trust the
   *  server's `taskRunning: false`: a reconnect landing in the tiny pre-ack
   *  gap reports false simply because the server task hasn't started, and
   *  clearing the optimistic indicator there causes a visible blink. Outside
   *  this window the server is authoritative in both directions — which is
   *  what recovers a stuck "Thinking…" indicator after a missed
   *  `task-completed` (buffer eviction, server restart, or the completion
   *  broadcast firing while this client was detached). */
  pendingOptimisticTask: boolean;
}

export const INITIAL_STATE: ChatSubscriptionState = {
  messages: [],
  status: "idle",
  sessionId: undefined,
  queuedMessages: [],
  usage: undefined,
  lastEventId: undefined,
  taskRunning: false,
  taskErrorMessage: undefined,
  currentAssistantId: undefined,
  messageIdCounter: 0,
  pendingOptimisticTask: false,
};

// ---------------------------------------------------------------------------
// Helpers — pure, no allocation of state objects until needed
// ---------------------------------------------------------------------------

/** UIMessage parts list typed loosely (we generate a subset). */
type UIMessageParts = UIMessage["parts"];

interface AssistantTextPart {
  type: "text";
  text: string;
}

interface AssistantToolPart {
  type: `tool-${string}`;
  toolCallId: string;
  state: "input-streaming" | "input-available" | "output-available" | "output-error";
  input?: unknown;
  output?: unknown;
  errorText?: string;
  title?: string;
  approval?: { id: string };
}

/** Append `part` to the assistant message with `id`. Returns a *new* messages
 *  array — caller must replace it in state. */
function appendPart(
  messages: UIMessage[],
  assistantId: string,
  part: AssistantTextPart | AssistantToolPart,
): UIMessage[] {
  const idx = messages.findIndex((m) => m.id === assistantId);
  if (idx === -1) {
    // Shouldn't happen — caller should have ensured the assistant message
    // exists. Defensively create one rather than crashing.
    return [
      ...messages,
      {
        id: assistantId,
        role: "assistant",
        parts: [part as unknown as UIMessageParts[number]],
      },
    ];
  }
  const before = messages[idx];
  const updated: UIMessage = {
    ...before,
    parts: [...before.parts, part as unknown as UIMessageParts[number]],
  };
  return [...messages.slice(0, idx), updated, ...messages.slice(idx + 1)];
}

/** Update the last text part on an assistant message by appending to its
 *  `text` field. If the most recent part isn't a text part with the matching
 *  `id`, append a new text part instead. */
function appendTextDelta(
  messages: UIMessage[],
  assistantId: string,
  textPartId: string,
  delta: string,
): UIMessage[] {
  const idx = messages.findIndex((m) => m.id === assistantId);
  if (idx === -1) {
    return [
      ...messages,
      {
        id: assistantId,
        role: "assistant",
        parts: [{ type: "text", text: delta } as unknown as UIMessageParts[number]],
      },
    ];
  }
  const before = messages[idx];
  const parts = [...before.parts];
  const lastIdx = parts.length - 1;
  type TextPartWithId = { type: "text"; text: string; id?: string };
  const last = parts[lastIdx] as unknown as TextPartWithId | undefined;
  if (last && last.type === "text" && last.id === textPartId) {
    parts[lastIdx] = {
      type: "text",
      text: last.text + delta,
      id: textPartId,
    } as unknown as UIMessageParts[number];
  } else {
    parts.push({ type: "text", text: delta, id: textPartId } as unknown as UIMessageParts[number]);
  }
  return [...messages.slice(0, idx), { ...before, parts }, ...messages.slice(idx + 1)];
}

/** Find an existing tool part by `toolCallId` and replace it; otherwise no-op. */
function replaceToolPart(
  messages: UIMessage[],
  assistantId: string,
  toolCallId: string,
  next: AssistantToolPart,
): UIMessage[] {
  const idx = messages.findIndex((m) => m.id === assistantId);
  if (idx === -1) return messages;
  const before = messages[idx];
  const partIdx = before.parts.findIndex((p) => {
    const pp = p as unknown as { toolCallId?: string };
    return pp.toolCallId === toolCallId;
  });
  if (partIdx === -1) {
    // Tool output before tool input — shouldn't happen, but append rather than crash.
    return appendPart(messages, assistantId, next);
  }
  const parts = [...before.parts];
  parts[partIdx] = next as unknown as UIMessageParts[number];
  return [...messages.slice(0, idx), { ...before, parts }, ...messages.slice(idx + 1)];
}

function makeToolInputPart(evt: ToolInputAvailableEvent): AssistantToolPart {
  return {
    type: `tool-${evt.toolName}`,
    toolCallId: evt.toolCallId,
    state: "input-available",
    input: evt.input,
    title: evt.displayTitle,
    approval: evt.approvalId ? { id: evt.approvalId } : undefined,
  };
}

/** Concatenated text of a user message's text parts. Used to match an
 *  optimistic pending bubble against the server's echoed `user-message`
 *  event so we can replace rather than duplicate. */
function extractText(msg: UIMessage): string {
  return msg.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}

function makeToolOutputPart(
  prev: AssistantToolPart | undefined,
  evt: ToolOutputAvailableEvent,
): AssistantToolPart {
  // Preserve the previous part's metadata (toolName, input, title) and
  // overlay the output. Without this we'd lose `input` after the output
  // arrives.
  return {
    type: prev?.type ?? `tool-unknown`,
    toolCallId: evt.toolCallId,
    state: evt.isError ? "output-error" : "output-available",
    input: prev?.input,
    output: evt.isError ? undefined : evt.output,
    errorText: evt.isError ? evt.output : undefined,
    title: prev?.title,
    approval: prev?.approval,
  };
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/**
 * Apply a single `ChatEvent` to state. Pure: no side effects.
 *
 * Ordering invariant: callers must apply events in monotonic `eventId`
 * order. The reducer doesn't enforce this — but `chatEventReducer` updates
 * `lastEventId` regardless, so out-of-order events would corrupt the cursor.
 */
export function chatEventReducer(
  state: ChatSubscriptionState,
  event: ChatEvent,
): ChatSubscriptionState {
  // Always advance the cursor.
  const lastEventId = Math.max(state.lastEventId ?? 0, event.eventId);

  switch (event.type) {
    case "subscription-opened": {
      if (state.pendingOptimisticTask) {
        // Pre-ack window: `send()` just dispatched a synthetic optimistic
        // task-started, but the server hasn't acknowledged it yet. A
        // subscription-opened landing here reports `taskRunning: false`
        // simply because the server task hasn't started — trusting it would
        // clear the optimistic thinking indicator and blink before the real
        // `task-started` arrives. Only upgrade false→true in this window.
        const taskRunning = state.taskRunning || event.taskRunning;
        return {
          ...state,
          lastEventId,
          sessionId: event.sessionId ?? state.sessionId,
          taskRunning,
          status: taskRunning ? "streaming" : state.status,
        };
      }

      // No optimistic task pending — the server's `taskRunning` is
      // authoritative in BOTH directions. The server reports false for a
      // task that completed (or was evicted) while we were detached, so
      // honouring false is what clears a stuck "Thinking…" indicator after a
      // missed `task-completed` (buffer eviction past MAX_BUFFER_SIZE, server
      // restart, or the live-only completion broadcast firing while this
      // client had no open EventSource). Previously this only ever upgraded
      // false→true, so once the client believed a task was running no
      // reconnect could ever clear it — the indicator spun until a full page
      // reload reset the reducer.
      const taskRunning = event.taskRunning;
      let status = state.status;
      if (taskRunning) {
        status = "streaming";
      } else if (state.taskRunning) {
        // We believed a task was running; the server says it isn't. Settle to
        // a terminal/idle state so the per-message indicator, the standalone
        // indicator, and the composer Stop→Send affordance all recover.
        // `completed` when there's an assistant reply to show, else `idle`.
        status = state.messages.some((m) => m.role === "assistant") ? "completed" : "idle";
      }
      return {
        ...state,
        lastEventId,
        sessionId: event.sessionId ?? state.sessionId,
        taskRunning,
        status,
      };
    }

    case "session-resolved":
      return { ...state, lastEventId, sessionId: event.sessionId };

    case "user-message": {
      const isPending = event.eventId < 0;
      const nextCounter = state.messageIdCounter + 1;
      const messageId = isPending ? `u-pending-${nextCounter}` : `u-${nextCounter}`;
      const message: UIMessage = {
        id: messageId,
        role: "user",
        parts: [
          ...(event.text
            ? [{ type: "text", text: event.text } as unknown as UIMessageParts[number]]
            : []),
          ...(event.files ?? []).map(
            (f) =>
              ({
                type: "file",
                mediaType: f.mediaType,
                url: f.url,
                filename: f.filename,
              }) as unknown as UIMessageParts[number],
          ),
        ],
      };

      // Optimistic replace: if this is the real server echo (positive
      // eventId) and the previous message in state is a pending user-msg
      // with the same text, replace it instead of appending. Avoids the
      // "user message appears late, after the agent already started
      // responding" flash that real-world send → session-start latency
      // produces (the user-message broadcast happens server-side AFTER
      // session-start, which can be 1-2s on cold agent boot).
      if (!isPending) {
        const lastIdx = state.messages.length - 1;
        const last = state.messages[lastIdx];
        if (
          last &&
          last.role === "user" &&
          last.id.startsWith("u-pending-") &&
          extractText(last) === event.text
        ) {
          // Reuse the pending bubble's id when replacing so React keeps the
          // same component mounted — no unmount/remount flicker. Don't
          // bump the counter; we're not adding a new message.
          const replacement: UIMessage = { ...message, id: last.id.replace("u-pending-", "u-") };
          return {
            ...state,
            lastEventId,
            messages: [...state.messages.slice(0, lastIdx), replacement],
            currentAssistantId: undefined,
          };
        }
      }

      return {
        ...state,
        lastEventId,
        messageIdCounter: nextCounter,
        messages: [...state.messages, message],
        // A user message implicitly ends any prior assistant accumulation.
        currentAssistantId: undefined,
      };
    }

    case "task-started":
      return {
        ...state,
        lastEventId,
        taskRunning: true,
        status: "submitting",
        taskErrorMessage: undefined,
        currentAssistantId: undefined,
        // Negative eventId ⇒ this is `send()`'s synthetic pre-ack task-started.
        // A real server task-started (positive eventId) acknowledges it and
        // clears the pending flag, re-enabling authoritative downgrades.
        pendingOptimisticTask: event.eventId < 0,
      };

    case "task-completed":
      return {
        ...state,
        lastEventId,
        taskRunning: false,
        status: "completed",
        currentAssistantId: undefined,
        pendingOptimisticTask: false,
      };

    case "task-error":
      return {
        ...state,
        lastEventId,
        taskRunning: false,
        status: "error",
        taskErrorMessage: event.message,
        currentAssistantId: undefined,
        pendingOptimisticTask: false,
      };

    case "text-start": {
      // Ensure an assistant message exists. Counter-based id for global
      // uniqueness across sessions (server eventIds collide on JSONL replay).
      const created = state.currentAssistantId === undefined;
      const nextCounter = created ? state.messageIdCounter + 1 : state.messageIdCounter;
      const assistantId = state.currentAssistantId ?? `a-${nextCounter}`;
      let messages = state.messages;
      if (created) {
        messages = [...messages, { id: assistantId, role: "assistant", parts: [] }];
      }
      return {
        ...state,
        lastEventId,
        // Only enter "streaming" when a task is actually running. JSONL
        // backfill replays text-start/delta/end for past turns without
        // emitting task-completed (those are live-only events), so we
        // can't blindly flip status here — that's what made the thinking
        // indicator spin forever on a workspace with prior history.
        status: state.taskRunning ? "streaming" : state.status,
        currentAssistantId: assistantId,
        messageIdCounter: nextCounter,
        messages,
      };
    }

    case "text-delta": {
      const created = state.currentAssistantId === undefined;
      const nextCounter = created ? state.messageIdCounter + 1 : state.messageIdCounter;
      const assistantId = state.currentAssistantId ?? `a-${nextCounter}`;
      let messages = state.messages;
      if (created) {
        // text-delta without preceding text-start — shouldn't happen but
        // defensively create the assistant message.
        messages = [...messages, { id: assistantId, role: "assistant", parts: [] }];
      }
      messages = appendTextDelta(messages, assistantId, event.id, event.delta);
      return {
        ...state,
        lastEventId,
        // Gate on taskRunning — see the text-start branch for why.
        status: state.taskRunning ? "streaming" : state.status,
        currentAssistantId: assistantId,
        messageIdCounter: nextCounter,
        messages,
      };
    }

    case "text-end":
      // No-op for the messages shape — the text part is already in place.
      // We just record the cursor.
      return { ...state, lastEventId };

    case "tool-input-available": {
      const created = state.currentAssistantId === undefined;
      const nextCounter = created ? state.messageIdCounter + 1 : state.messageIdCounter;
      const assistantId = state.currentAssistantId ?? `a-${nextCounter}`;
      let messages = state.messages;
      if (created) {
        messages = [...messages, { id: assistantId, role: "assistant", parts: [] }];
      }
      messages = appendPart(messages, assistantId, makeToolInputPart(event));
      return {
        ...state,
        lastEventId,
        // Gate on taskRunning — same reasoning as text-start/text-delta.
        // JSONL backfill replays past tool calls without a closing
        // task-completed, so we'd be stuck "streaming" otherwise.
        status: state.taskRunning ? "streaming" : state.status,
        currentAssistantId: assistantId,
        messageIdCounter: nextCounter,
        messages,
      };
    }

    case "tool-output-available": {
      // Route by `toolCallId` rather than `state.currentAssistantId`.
      //
      // `currentAssistantId` is reset to `undefined` by five events
      // (`user-message` ×2 paths, `task-started`, `task-completed`,
      // `task-error`), so any tool result that arrives *after* one of those
      // — agent flushes asynchronously, user interrupts with a new
      // message, reconnect during JSONL backfill — would be silently
      // dropped. The stuck `input-available` parts kept their
      // `animate-pulse` dots alive forever (issue #509). `toolCallId` is
      // globally unique, so a reverse-walk of the message list will find
      // the owning assistant message regardless of which task is "current".
      let ownerId: string | undefined;
      let prevPart: AssistantToolPart | undefined;
      for (let i = state.messages.length - 1; i >= 0; i--) {
        const msg = state.messages[i];
        if (msg.role !== "assistant") continue;
        const part = msg.parts.find((p) => {
          const pp = p as unknown as { toolCallId?: string };
          return pp.toolCallId === event.toolCallId;
        });
        if (part) {
          ownerId = msg.id;
          prevPart = part as unknown as AssistantToolPart;
          break;
        }
      }
      if (!ownerId) {
        // Genuinely unknown toolCallId — log loudly. Silent drops are how
        // this bug went undetected for so long; a visible warning lets
        // future regressions surface in normal usage.
        console.warn(
          "[chat] tool-output-available for unknown toolCallId — dropping",
          event.toolCallId,
        );
        return { ...state, lastEventId };
      }
      const messages = replaceToolPart(
        state.messages,
        ownerId,
        event.toolCallId,
        makeToolOutputPart(prevPart, event),
      );
      return { ...state, lastEventId, messages };
    }

    case "usage":
      return { ...state, lastEventId, usage: event.data };

    case "result":
      // Surfaced as metadata only — no message-shape change. Result arrives
      // *after* task-completed/error in the existing protocol, so status is
      // already settled.
      return { ...state, lastEventId };

    case "error": {
      // Generic agent error — append a sentinel text part to the current
      // assistant message so the user sees something. Mirrors the legacy
      // behaviour where `error` chunks rendered inline.
      const created = state.currentAssistantId === undefined;
      const nextCounter = created ? state.messageIdCounter + 1 : state.messageIdCounter;
      const assistantId = state.currentAssistantId ?? `a-${nextCounter}`;
      let messages = state.messages;
      if (created) {
        messages = [...messages, { id: assistantId, role: "assistant", parts: [] }];
      }
      messages = appendPart(messages, assistantId, {
        type: "text",
        text: `\n\n_Error: ${event.message}_`,
      });
      return {
        ...state,
        lastEventId,
        currentAssistantId: assistantId,
        messageIdCounter: nextCounter,
        messages,
      };
    }

    case "file": {
      // Attach an assistant-produced file (image, download, scanned shared-
      // dir artifact) as a `file` part on the current assistant message.
      // Mirror the create-on-demand pattern used by text-start/tool-input —
      // a `file` event can arrive before any text-delta if the agent's
      // first output is a tool that drops a file.
      const created = state.currentAssistantId === undefined;
      const nextCounter = created ? state.messageIdCounter + 1 : state.messageIdCounter;
      const assistantId = state.currentAssistantId ?? `a-${nextCounter}`;
      let messages = state.messages;
      if (created) {
        messages = [...messages, { id: assistantId, role: "assistant", parts: [] }];
      }
      const filePart = {
        type: "file" as const,
        mediaType: event.mediaType,
        url: event.url,
        ...(event.filename ? { filename: event.filename } : {}),
      };
      const idx = messages.findIndex((m) => m.id === assistantId);
      if (idx === -1) {
        return { ...state, lastEventId, messages };
      }
      const before = messages[idx];
      const updated: UIMessage = {
        ...before,
        parts: [...before.parts, filePart as unknown as UIMessageParts[number]],
      };
      messages = [...messages.slice(0, idx), updated, ...messages.slice(idx + 1)];
      return {
        ...state,
        lastEventId,
        currentAssistantId: assistantId,
        messageIdCounter: nextCounter,
        messages,
      };
    }

    case "queue-updated":
      return { ...state, lastEventId, queuedMessages: event.messages };

    default: {
      // Exhaustiveness check — TypeScript will flag unhandled members of the
      // ChatEvent union.
      const _exhaustive: never = event;
      void _exhaustive;
      return { ...state, lastEventId };
    }
  }
}

/** Convenience: fold an entire event sequence. Used by tests and by the hook
 *  on initial replay. */
export function applyEvents(
  state: ChatSubscriptionState,
  events: ChatEvent[],
): ChatSubscriptionState {
  let next = state;
  for (const evt of events) next = chatEventReducer(next, evt);
  return next;
}
