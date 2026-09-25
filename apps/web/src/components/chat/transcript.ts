/**
 * The chat transcript, and how each chat event changes it (issue #648).
 *
 * Pure: `useChatSubscription` keeps the state in a `useReducer` and runs
 * every event from `/api/chats/:id/events` through `transcriptReducer`, so
 * every rule for what an ACP `session/update` means for the chat pane lives
 * here. No I/O, no clocks, no randomness: tests fold fixed event lists.
 *
 * The transcript is a list of messages. A user message is one prompt; an
 * assistant message holds everything the agent produced until the next
 * prompt (text, thoughts, tool calls, permission requests, files,
 * notices). Streaming only ever replaces the last message, so the rows the
 * virtualized list already rendered keep their identity.
 */

import type {
  CreateElicitationRequest,
  PlanEntry,
  RequestPermissionRequest,
  SessionUpdate,
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolKind,
} from "@agentclientprotocol/sdk";
import type {
  ChatEvent,
  ChatEventFile,
  QueuedChatMessage,
  SessionState,
} from "../../shared/chat-events";

export interface ToolEntry {
  kind: "tool";
  id: string;
  title: string;
  /** The agent's programmatic tool name, when it sends one. */
  name?: string;
  toolKind?: ToolKind;
  status: ToolCallStatus;
  content: ToolCallContent[];
  locations: ToolCallLocation[];
  rawInput?: unknown;
  rawOutput?: unknown;
}

export type Entry =
  | { kind: "text"; id: string; text: string; messageId: string | null }
  | { kind: "thought"; id: string; text: string; messageId: string | null }
  | ToolEntry
  | {
      kind: "permission";
      id: string;
      request: RequestPermissionRequest;
      /** The picked option id, or `cancelled`. Absent while it waits. */
      answer?: string;
    }
  | {
      kind: "elicitation";
      id: string;
      request: CreateElicitationRequest;
      /** `accept`, `decline` or `cancelled`. Absent while it waits. */
      answer?: string;
    }
  | { kind: "file"; id: string; file: ChatEventFile }
  | { kind: "notice"; id: string; level: "info" | "warning" | "error"; text: string };

export type ChatMessage =
  | {
      role: "user";
      id: string;
      text: string;
      files?: ChatEventFile[];
      /** Shown before the server logged it (optimistic send). */
      pending?: boolean;
      /** Built from replayed `user_message_chunk`s rather than a prompt. */
      replayed?: boolean;
    }
  | { role: "assistant"; id: string; entries: Entry[] };

export type ChatStatus = "idle" | "submitting" | "streaming" | "error";

export interface TranscriptState {
  messages: ChatMessage[];
  status: ChatStatus;
  /** True while the server runs a turn for this chat. */
  taskRunning: boolean;
  /** An optimistic send the server hasn't confirmed with `turn-started`. */
  pendingSend: boolean;
  sessionId: string | undefined;
  /** Log revision the events came from; sent back on reconnect. */
  revision: number;
  /** Highest logged event id applied; the gap-fill cursor. */
  lastEventId: number | undefined;
  queue: QueuedChatMessage[];
  session: SessionState | null;
  /** The agent's current plan (ACP `plan`, e.g. Claude Code's todos). */
  plan: PlanEntry[];
  hasOlder: boolean;
  oldestEventId: number | undefined;
  errorMessage: string | undefined;
}

export const INITIAL_TRANSCRIPT: TranscriptState = {
  messages: [],
  status: "idle",
  taskRunning: false,
  pendingSend: false,
  sessionId: undefined,
  revision: 0,
  lastEventId: undefined,
  queue: [],
  session: null,
  plan: [],
  hasOlder: false,
  oldestEventId: undefined,
  errorMessage: undefined,
};

/** Client-side actions that aren't server events. */
export type TranscriptAction =
  | ChatEvent
  | { type: "local-send"; id: string; text: string; files?: ChatEventFile[] }
  | { type: "local-send-failed"; message: string }
  | { type: "local-answer"; requestId: string; answer: string }
  | { type: "local-prepend"; messages: ChatMessage[]; hasOlder: boolean; oldestEventId: number };

// ---------------------------------------------------------------------------
// Message helpers. Each returns a new messages array, touching only the
// message it changes.
// ---------------------------------------------------------------------------

function lastAssistant(messages: ChatMessage[], id: string): [ChatMessage[], number] {
  const last = messages[messages.length - 1];
  if (last?.role === "assistant") return [messages, messages.length - 1];
  return [[...messages, { role: "assistant", id, entries: [] }], messages.length];
}

function withEntries(
  messages: ChatMessage[],
  index: number,
  change: (entries: Entry[]) => Entry[],
): ChatMessage[] {
  const message = messages[index];
  if (message.role !== "assistant") return messages;
  const next = messages.slice();
  next[index] = { ...message, entries: change(message.entries) };
  return next;
}

function addEntry(messages: ChatMessage[], eventId: number, entry: Entry): ChatMessage[] {
  const [list, index] = lastAssistant(messages, `a${eventId}`);
  return withEntries(list, index, (entries) => [...entries, entry]);
}

/** Streamed text arrives in chunks; consecutive chunks of one message are one entry. */
function appendText(
  messages: ChatMessage[],
  eventId: number,
  kind: "text" | "thought",
  text: string,
  messageId: string | null,
): ChatMessage[] {
  const [list, index] = lastAssistant(messages, `a${eventId}`);
  return withEntries(list, index, (entries) => {
    const last = entries[entries.length - 1];
    if (last && last.kind === kind && last.messageId === messageId) {
      return [...entries.slice(0, -1), { ...last, text: last.text + text }];
    }
    return [...entries, { kind, id: `${kind}${eventId}`, text, messageId }];
  });
}

/** Finds a tool entry, newest message first. */
function findTool(messages: ChatMessage[], toolCallId: string): [number, number] | null {
  for (let m = messages.length - 1; m >= 0; m--) {
    const message = messages[m];
    if (message.role !== "assistant") continue;
    const e = message.entries.findIndex((x) => x.kind === "tool" && x.id === toolCallId);
    if (e >= 0) return [m, e];
  }
  return null;
}

function mapEntries(
  messages: ChatMessage[],
  change: (entry: Entry) => Entry,
  scope: "all" | "last" = "all",
): ChatMessage[] {
  let changed = false;
  const next = messages.map((message, i) => {
    if (message.role !== "assistant") return message;
    if (scope === "last" && i !== messages.length - 1) return message;
    const entries = message.entries.map((e) => {
      const n = change(e);
      if (n !== e) changed = true;
      return n;
    });
    return entries.some((e, j) => e !== message.entries[j]) ? { ...message, entries } : message;
  });
  return changed ? next : messages;
}

function applyUpdate(
  state: TranscriptState,
  update: SessionUpdate,
  eventId: number,
): TranscriptState {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
    case "agent_thought_chunk": {
      if (update.content.type !== "text") return state;
      const kind = update.sessionUpdate === "agent_message_chunk" ? "text" : "thought";
      return {
        ...state,
        messages: appendText(
          state.messages,
          eventId,
          kind,
          update.content.text,
          update.messageId ?? null,
        ),
      };
    }

    case "user_message_chunk": {
      // Only replays (`session/load`) carry user messages; Band logs its own
      // prompts as `prompt` events.
      if (update.content.type !== "text") return state;
      const text = update.content.text;
      const last = state.messages[state.messages.length - 1];
      if (last?.role === "user" && last.replayed) {
        const messages = state.messages.slice();
        messages[messages.length - 1] = { ...last, text: last.text + text };
        return { ...state, messages };
      }
      return {
        ...state,
        messages: [...state.messages, { role: "user", id: `u${eventId}`, text, replayed: true }],
      };
    }

    case "tool_call": {
      const entry: ToolEntry = {
        kind: "tool",
        id: update.toolCallId,
        title: update.title,
        name: update.name ?? undefined,
        toolKind: update.kind,
        status: update.status ?? "pending",
        content: update.content ?? [],
        locations: update.locations ?? [],
        rawInput: update.rawInput,
        rawOutput: update.rawOutput,
      };
      const at = findTool(state.messages, update.toolCallId);
      // A repeated tool_call replaces the one already shown.
      if (at) {
        return {
          ...state,
          messages: withEntries(state.messages, at[0], (entries) =>
            entries.map((e, i) => (i === at[1] ? entry : e)),
          ),
        };
      }
      return { ...state, messages: addEntry(state.messages, eventId, entry) };
    }

    case "tool_call_update": {
      const at = findTool(state.messages, update.toolCallId);
      if (!at) {
        // An update for a call we never saw (it fell outside the loaded
        // window): show what the update carries.
        return applyUpdate(
          state,
          {
            ...update,
            sessionUpdate: "tool_call",
            title: update.title ?? update.name ?? "Tool call",
          } as SessionUpdate,
          eventId,
        );
      }
      return {
        ...state,
        messages: withEntries(state.messages, at[0], (entries) =>
          entries.map((e, i) =>
            i === at[1] && e.kind === "tool"
              ? {
                  ...e,
                  title: update.title ?? e.title,
                  name: update.name ?? e.name,
                  toolKind: update.kind ?? e.toolKind,
                  status: update.status ?? e.status,
                  content: update.content ?? e.content,
                  locations: update.locations ?? e.locations,
                  rawInput: update.rawInput !== undefined ? update.rawInput : e.rawInput,
                  rawOutput: update.rawOutput !== undefined ? update.rawOutput : e.rawOutput,
                }
              : e,
          ),
        ),
      };
    }

    // `plan` always carries the whole plan.
    case "plan":
      return { ...state, plan: update.entries };

    case "available_commands_update":
      return state.session
        ? { ...state, session: { ...state.session, commands: update.availableCommands } }
        : state;

    case "config_option_update":
      return state.session
        ? { ...state, session: { ...state.session, configOptions: update.configOptions } }
        : state;

    case "current_mode_update":
      return state.session?.modes
        ? {
            ...state,
            session: {
              ...state.session,
              modes: { ...state.session.modes, currentModeId: update.currentModeId },
            },
          }
        : state;

    case "usage_update": {
      if (!state.session) return state;
      const usage = { used: update.used, size: update.size, cost: update.cost ?? null };
      const cost = update.cost?.currency === "USD" ? update.cost.amount : state.session.costUsd;
      return { ...state, session: { ...state.session, usage, costUsd: cost } };
    }

    case "session_info_update":
      return state.session && update.title !== undefined
        ? { ...state, session: { ...state.session, title: update.title ?? null } }
        : state;

    case "notice":
      return {
        ...state,
        messages: addEntry(state.messages, eventId, {
          kind: "notice",
          id: `n${eventId}`,
          level:
            update.severity === "error"
              ? "error"
              : update.severity === "warning"
                ? "warning"
                : "info",
          text: update.description ? `${update.title}: ${update.description}` : update.title,
        }),
      };

    default:
      return state;
  }
}

/** A stopped turn leaves nothing spinning. */
function settle(messages: ChatMessage[], failed: boolean): ChatMessage[] {
  return mapEntries(
    messages,
    (e) => {
      if ((e.kind === "permission" || e.kind === "elicitation") && !e.answer) {
        return { ...e, answer: "cancelled" };
      }
      if (failed && e.kind === "tool" && (e.status === "pending" || e.status === "in_progress")) {
        return { ...e, status: "failed" };
      }
      return e;
    },
    "last",
  );
}

const STOP_NOTICES: Record<string, { level: "info" | "warning"; text: string }> = {
  cancelled: { level: "info", text: "Stopped." },
  refusal: { level: "warning", text: "The agent declined to continue." },
  max_tokens: { level: "warning", text: "The agent hit its token limit." },
  max_turn_requests: { level: "warning", text: "The agent hit its turn limit." },
};

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

export function transcriptReducer(
  state: TranscriptState,
  action: TranscriptAction,
): TranscriptState {
  switch (action.type) {
    case "local-send":
      return {
        ...state,
        messages: [
          ...state.messages,
          { role: "user", id: action.id, text: action.text, files: action.files, pending: true },
        ],
        status: "submitting",
        taskRunning: true,
        pendingSend: true,
        errorMessage: undefined,
      };

    case "local-send-failed":
      return {
        ...state,
        status: "error",
        taskRunning: false,
        pendingSend: false,
        errorMessage: action.message,
      };

    case "local-answer":
      return {
        ...state,
        messages: mapEntries(state.messages, (e) =>
          (e.kind === "permission" || e.kind === "elicitation") && e.id === action.requestId
            ? { ...e, answer: action.answer }
            : e,
        ),
      };

    case "local-prepend":
      return {
        ...state,
        messages: [...action.messages, ...state.messages],
        hasOlder: action.hasOlder,
        oldestEventId: action.oldestEventId,
      };

    case "subscription-opened": {
      const base = action.reset ? { ...INITIAL_TRANSCRIPT, queue: state.queue } : state;
      // The server is authoritative on whether a turn runs, except in the
      // moment between an optimistic send and its `turn-started`.
      const taskRunning = base.pendingSend ? true : action.taskRunning;
      return {
        ...base,
        sessionId: action.sessionId ?? base.sessionId,
        revision: action.revision,
        taskRunning,
        status: taskRunning
          ? base.pendingSend
            ? "submitting"
            : "streaming"
          : base.status === "error"
            ? "error"
            : "idle",
      };
    }

    case "queue-updated":
      return { ...state, queue: action.messages };

    case "session-state":
      return { ...state, session: action.state };

    case "history-meta":
      return {
        ...state,
        hasOlder: action.hasOlder,
        oldestEventId: action.oldestEventId || undefined,
      };

    default:
      break;
  }

  // Logged events: drop anything at or before the cursor (a replay the
  // client already has).
  if (
    action.eventId > 0 &&
    state.lastEventId !== undefined &&
    action.eventId <= state.lastEventId
  ) {
    return state;
  }
  const lastEventId =
    action.eventId > 0 ? Math.max(state.lastEventId ?? 0, action.eventId) : state.lastEventId;
  const next = applyLogged(state, action);
  return next === state && lastEventId === state.lastEventId ? state : { ...next, lastEventId };
}

function applyLogged(state: TranscriptState, event: ChatEvent): TranscriptState {
  switch (event.type) {
    case "update":
      return applyUpdate(state, event.update, event.eventId);

    case "prompt": {
      // Confirm the optimistic bubble in place, so its row doesn't remount.
      const pending = state.messages.findIndex(
        (m) => m.role === "user" && m.pending && m.text === event.text,
      );
      if (pending >= 0) {
        const messages = state.messages.slice();
        const m = messages[pending];
        if (m.role === "user")
          messages[pending] = { ...m, files: event.files ?? m.files, pending: false };
        return { ...state, messages };
      }
      return {
        ...state,
        messages: [
          ...state.messages,
          { role: "user", id: `u${event.eventId}`, text: event.text, files: event.files },
        ],
      };
    }

    case "turn-started":
      return {
        ...state,
        taskRunning: true,
        pendingSend: false,
        status: "streaming",
        errorMessage: undefined,
      };

    case "turn-ended": {
      const failed = event.error !== undefined || event.stopReason === "cancelled";
      let messages = settle(state.messages, failed);
      const notice = event.error
        ? { level: "error" as const, text: event.error }
        : event.stopReason
          ? STOP_NOTICES[event.stopReason]
          : undefined;
      if (notice) {
        messages = addEntry(messages, event.eventId, {
          kind: "notice",
          id: `n${event.eventId}`,
          ...notice,
        });
      }
      const cost = event.usage?.costUsd;
      return {
        ...state,
        messages,
        taskRunning: false,
        pendingSend: false,
        status: event.error ? "error" : "idle",
        errorMessage: event.error,
        session:
          state.session && cost !== undefined ? { ...state.session, costUsd: cost } : state.session,
      };
    }

    case "permission":
      return {
        ...state,
        messages: addEntry(state.messages, event.eventId, {
          kind: "permission",
          id: event.requestId,
          request: event.request,
        }),
      };

    case "elicitation":
      return {
        ...state,
        messages: addEntry(state.messages, event.eventId, {
          kind: "elicitation",
          id: event.requestId,
          request: event.request,
        }),
      };

    case "request-resolved":
      return {
        ...state,
        messages: mapEntries(state.messages, (e) =>
          (e.kind === "permission" || e.kind === "elicitation") && e.id === event.requestId
            ? { ...e, answer: event.answer }
            : e,
        ),
      };

    case "session-attached":
      return {
        ...state,
        sessionId: event.sessionId,
        session: {
          ...(state.session ?? {
            source: "live",
            commands: [],
            usage: null,
            costUsd: null,
            title: null,
            canListSessions: true,
          }),
          source: "live",
          configOptions: event.configOptions,
          modes: event.modes,
          models: event.models,
        },
      };

    case "file":
      return {
        ...state,
        messages: addEntry(state.messages, event.eventId, {
          kind: "file",
          id: `f${event.eventId}`,
          file: { mediaType: event.mediaType, url: event.url, filename: event.filename },
        }),
      };

    case "notice":
      return {
        ...state,
        messages: addEntry(state.messages, event.eventId, {
          kind: "notice",
          id: `n${event.eventId}`,
          level: event.level,
          text: event.text,
        }),
      };

    default:
      return state;
  }
}

/** Folds a list of events into a state, e.g. an older history page. */
export function foldEvents(state: TranscriptState, events: ChatEvent[]): TranscriptState {
  let s = state;
  for (const e of events) s = transcriptReducer(s, e);
  return s;
}
