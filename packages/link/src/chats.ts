/**
 * Chat ownership on a worker.
 *
 * A worker whose hello lists `chatOwnership` runs the ACP client and the
 * event log for the chats the hub hands it with `chat.own`. It replicates
 * every row it logs to the hub with `chat.replicate`, and the hub forwards
 * what other clients ask of the chat with `chat.forward`.
 */

import type { JsonPayload } from "./payload.ts";

/** The capability a worker lists in its hello when it can own chats. */
export const CAPABILITY_CHAT_OWNERSHIP = "chatOwnership";

/** How many event ids the hub leases a worker at once. */
export const CHAT_ID_BLOCK_SIZE = 1_000_000;

/** One `chat_events` row, as both logs store it. `event` is a `LoggedChatEvent`. */
export interface ChatEventRowWire {
  id: number;
  chatId: string;
  sessionId: string;
  revision: number;
  turnStart: boolean;
  createdAt: number;
  event: unknown;
}

/** What the worker needs to know about a chat, kept in its own store. */
export interface OwnedChatInfo {
  chatId: string;
  worktreeId: string;
  /** The settings id of the chat's coding agent. */
  agentId: string;
  model?: string;
  mode?: string;
  activeSessionId?: string;
  /** Whether the session has a summary yet: a turn without one is the session's first. */
  hasSummary: boolean;
}

// ---- hub → worker ----------------------------------------------------------

/** Hands the worker a chat. The worker then pulls its log with `chat.history`. */
export const METHOD_CHAT_OWN = "chat.own";
export interface ChatOwnParams {
  chat: OwnedChatInfo;
}

/**
 * A request from another client. `forwardId` is the hub's outbox id; the
 * worker remembers it, so a resend after a lost reply runs nothing twice.
 */
export const METHOD_CHAT_FORWARD = "chat.forward";
export type ChatForwardAction =
  | {
      kind: "send";
      text: string;
      files?: { path: string; mediaType: string; url: string; filename?: string }[];
      sessionId?: string;
      mode?: string;
      model?: string;
      codingAgentId?: string;
    }
  | { kind: "stop" }
  | { kind: "permission"; requestId: string; optionId: string | null }
  | { kind: "elicitation"; requestId: string; response: unknown }
  | { kind: "queue-remove"; queuedMessageId: string }
  | { kind: "queue-update"; queuedMessageId: string; text: string }
  | { kind: "queue-reorder"; ids: string[] }
  | { kind: "queue-clear" };
export interface ChatForwardParams {
  forwardId: string;
  chatId: string;
  action: ChatForwardAction;
}
export interface ChatForwardReply {
  /** False when the action found nothing to act on (no such request, no turn running). */
  ok: boolean;
  /** For a send: whether it waits behind a running turn. */
  queued?: boolean;
}

/** Ends the worker's ownership. It finishes replicating first, then stops the chat's agent. */
export const METHOD_CHAT_RELEASE = "chat.release";
export interface ChatReleaseParams {
  chatId: string;
  /** Delete the worker's copy of the log too (the chat was removed). */
  deleteLog?: boolean;
}

/** Changes a session setting on the worker's live session. Replies with the session state. */
export const METHOD_CHAT_SET_CONFIG = "chat.setConfigOption";
export interface ChatSetConfigParams {
  chatId: string;
  configId: string;
  value: string;
}

/** The agent's past sessions in the chat's worktree (`session/list`), or null when it can't list. */
export const METHOD_CHAT_LIST_SESSIONS = "chat.listSessions";
export interface ChatListSessionsReply {
  sessions: { sessionId: string; title?: string; updatedAt?: string }[] | null;
}

/**
 * Loads a session Band has no log for, so its history is logged and replicated before the
 * reply. Does nothing for a logged or busy session. Replies once the rows are on the hub.
 */
export const METHOD_CHAT_VIEW_SESSION = "chat.viewSession";

// ---- worker → hub ----------------------------------------------------------

/**
 * Rows the worker logged, oldest first. The hub inserts the ones it does not
 * have and acks the batch, after which the worker never sends them again.
 */
export const METHOD_CHAT_REPLICATE = "chat.replicate";
export interface ChatReplicateParams {
  /** A {@link JsonPayload} of `ChatEventRowWire[]`. */
  rows: JsonPayload;
}
export interface ChatReplicateReply {
  /** The highest id the hub now holds from this batch. */
  ackedThrough: number;
}

/** Leases the worker a fresh block of event ids, above every id the hub has used. */
export const METHOD_CHAT_ID_BLOCK = "chat.idBlock";
export interface ChatIdBlockReply {
  start: number;
  size: number;
}

/** Rows of a chat the hub holds after `afterId`, every session, oldest first. */
export const METHOD_CHAT_HISTORY = "chat.history";
export interface ChatHistoryParams {
  chatId: string;
  afterId: number;
  limit: number;
}
export interface ChatHistoryReply {
  /** A {@link JsonPayload} of `ChatEventRowWire[]`. */
  rows: JsonPayload;
}

/**
 * What it takes to start the chat's agent: the agent definition, the
 * environment the hub adds (relay grant, chat ids), the MCP servers with a
 * fresh token, and the directories. Asked for each time the worker starts
 * an agent process while the hub is reachable, and kept for when it is not.
 */
export const METHOD_CHAT_LAUNCH = "chat.launch";
export interface ChatLaunchParams {
  chatId: string;
  /** Start this agent instead of the chat's (a message that switches agents). */
  agentId?: string;
}
export interface ChatLaunchReply {
  chat: OwnedChatInfo;
  agent: { id: string; type: string; label: string; command?: string; model?: string };
  cwd: string;
  env: Record<string, string>;
  /** The login's credential variables. The worker applies them to the child and never stores them. */
  loginEnv?: Record<string, string>;
  /** Variables removed from the inherited environment before `env` is merged (an agent login). */
  unsetEnv?: string[];
  /** ACP `McpServer` entries. Passed only to an agent that supports HTTP MCP servers. */
  mcpServers: unknown[];
  additionalDirectories: string[];
  /** The worktree's shared directory: files the agent drops here become cards in the chat. */
  sharedDir: string | null;
}

/**
 * The hub's session settings for a chat the worker has no session for yet: the
 * agent catalog with the chat's saved model and mode. A `SessionState`.
 */
export const METHOD_CHAT_SESSION_STATE = "chat.sessionState";

/** The worker's live state of a chat changed. Sent for every owned chat on each connect too. */
export const NOTIFY_CHAT_LIVE = "chat.live.changed";
export interface ChatLiveState {
  chatId: string;
  taskRunning: boolean;
  /** The running turn's task id and start, so the hub can report it. */
  task?: { id: string; startedAt: number; prompt: string };
  queue: {
    id: string;
    text: string;
    files?: { mediaType: string; url: string; filename?: string }[];
  }[];
  /** Request ids the agent waits on the user for. */
  pending: string[];
  /** The soonest lapse of the agent's background work, or null with none. */
  workDeadline: number | null;
  /** A `SessionState`, when the worker has a live session. */
  sessionState?: unknown;
}

/** An event the worker broadcast without logging (a notice before any session, a session state). */
export const NOTIFY_CHAT_TRANSIENT = "chat.transient";
export interface ChatTransientParams {
  chatId: string;
  event: unknown;
}

/** The agent acted outside a turn: an update of its own turn, or background work starting or ending. */
export const NOTIFY_CHAT_ACTIVITY = "chat.activity";
export interface ChatActivityParams {
  chatId: string;
  kind: "update" | "work";
}
