/**
 * Chat pane lifecycle management.
 *
 * Each chat pane maps 1:1 to a running agent process on the server.
 * Modeled on terminal-manager.ts — in-memory registry backed by the
 * generic `panel_states` table for persistence across server restarts.
 */

import { createLogger } from "@band-app/logger";
import { removeAgent } from "./agent-pool";
import { addChatToLayout, getChatLayout, removeChatFromLayout } from "./chat-layout-manager";
import { defaultPanelIdFromLayout } from "./dockview-layout-manager";
import {
  deletePanelState,
  deletePanelStatesForWorkspace,
  insertPanelState,
  listPanelStates,
  updatePanelState,
} from "./panel-state-store";
import { getAgentDefinition, loadSettings } from "./state";
import { emit } from "./watcher";

const log = createLogger("chat-manager");

const PANEL_TYPE = "chat";

export type ChatStatus = "running" | "idle" | "stopped" | "error";

export interface ChatSession {
  id: string;
  workspaceId: string;
  name: string;
  agent: string; // coding agent definition id
  model?: string;
  mode?: string;
  /** The session the user last viewed — restored on page load. */
  activeSessionId?: string;
  /**
   * Cached display title for `activeSessionId` so the chat pane can render
   * its tab title without a filesystem walk on the hot path. Refreshed in
   * the background by `chats.get`.
   */
  activeSessionSummary?: string;
  /**
   * Cached lastModified (ms epoch) for `activeSessionId`. Used by the
   * background refresh to skip the read when the JSONL file hasn't
   * changed since the cached value was written.
   */
  activeSessionLastModified?: number;
  status: ChatStatus;
}

/** Shape of the JSON blob stored in `panel_states.state` for chat panels. */
interface ChatPanelState {
  name: string;
  agent: string;
  model?: string | null;
  mode?: string | null;
  /** The session the user last viewed. */
  activeSessionId?: string | null;
  /** Cached display title for activeSessionId. */
  activeSessionSummary?: string | null;
  /** Cached lastModified (ms epoch) for activeSessionId. */
  activeSessionLastModified?: number | null;
  status: ChatStatus;
}

// ---------------------------------------------------------------------------
// In-memory indices
// ---------------------------------------------------------------------------

/** Primary index: chatId -> ChatSession */
const chatSessions = new Map<string, ChatSession>();

/** Reverse index: workspaceId -> Set<chatId> */
const workspaceChats = new Map<string, Set<string>>();

/**
 * Lazy initialization flag.  In dev mode (vite dev) the module may be loaded
 * without an explicit `loadChatsFromDb()` call from start-server.ts.  The
 * first public read ensures the DB is hydrated so callers always see
 * persisted chat records.
 */
let _initialized = false;

function ensureInitialized(): void {
  if (_initialized) return;
  _initialized = true;
  loadChatsFromDb();
}

function addToIndex(session: ChatSession): void {
  chatSessions.set(session.id, session);
  let ids = workspaceChats.get(session.workspaceId);
  if (!ids) {
    ids = new Set();
    workspaceChats.set(session.workspaceId, ids);
  }
  ids.add(session.id);
}

function removeFromIndex(chatId: string): void {
  const session = chatSessions.get(chatId);
  if (!session) return;
  chatSessions.delete(chatId);
  const ids = workspaceChats.get(session.workspaceId);
  if (ids) {
    ids.delete(chatId);
    if (ids.size === 0) {
      workspaceChats.delete(session.workspaceId);
    }
  }
}

function generateChatId(): string {
  return `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function serializeState(session: ChatSession): string {
  const blob: ChatPanelState = {
    name: session.name,
    agent: session.agent,
    model: session.model ?? null,
    mode: session.mode ?? null,
    activeSessionId: session.activeSessionId ?? null,
    activeSessionSummary: session.activeSessionSummary ?? null,
    activeSessionLastModified: session.activeSessionLastModified ?? null,
    status: session.status,
  };
  return JSON.stringify(blob);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CreateChatOptions {
  /** Explicit ID — use when the client already generated one. */
  id?: string;
  name?: string;
  agent?: string;
  model?: string;
  mode?: string;
}

/**
 * Create a new chat pane for a workspace.
 * Persists to panel_states table and adds to in-memory registry.
 */
export function createChat(workspaceId: string, options?: CreateChatOptions): ChatSession {
  const settings = loadSettings();
  const defaultAgent = getAgentDefinition(settings);
  const now = Date.now();

  const session: ChatSession = {
    id: options?.id ?? generateChatId(),
    workspaceId,
    name: options?.name ?? "Chat",
    agent: options?.agent ?? defaultAgent.id,
    model: options?.model,
    mode: options?.mode,
    status: "idle",
  };

  insertPanelState({
    id: session.id,
    workspaceId: session.workspaceId,
    panelType: PANEL_TYPE,
    state: serializeState(session),
    createdAt: now,
    updatedAt: now,
  });

  addToIndex(session);

  // Mirror what `terminals.create` and `browsers.create` do: register the
  // new pane in the saved dockview layout so it shows up next time the
  // workspace is opened. Without this, chats created via the CLI (e.g.
  // `band workspaces create --prompt`, `band chats create`, or the lazy
  // `getOrCreateDefaultChat` path) exist as records but are invisible
  // in the dashboard until the user manually opens a tab. `addPanel`
  // is idempotent, so the dashboard's own "+ chat" button — which may
  // also touch the layout client-side — is unaffected.
  addChatToLayout(workspaceId, session.id, { title: session.name });

  // Notify any open dashboard so it can sync its dockview without a
  // page reload. Same pattern as `terminal-created` / `browser-created`.
  emit({ kind: "chat-created", workspaceId, chatId: session.id });

  log.info({ chatId: session.id, workspaceId, agent: session.agent }, "chat pane created");
  return session;
}

/**
 * Get a chat session by ID.
 */
export function getChat(chatId: string): ChatSession | undefined {
  ensureInitialized();
  return chatSessions.get(chatId);
}

/**
 * List all chat sessions for a workspace.
 */
export function listChats(workspaceId: string): ChatSession[] {
  ensureInitialized();
  const ids = workspaceChats.get(workspaceId);
  if (!ids) return [];
  const sessions: ChatSession[] = [];
  for (const id of ids) {
    const session = chatSessions.get(id);
    if (session) sessions.push(session);
  }
  return sessions;
}

export interface UpdateChatOptions {
  name?: string;
  agent?: string;
  model?: string | null;
  mode?: string | null;
}

/**
 * Update a chat pane's configuration.
 */
export function updateChat(chatId: string, updates: UpdateChatOptions): ChatSession | undefined {
  const session = chatSessions.get(chatId);
  if (!session) return undefined;

  if (updates.name !== undefined) session.name = updates.name;
  if (updates.agent !== undefined) session.agent = updates.agent;
  if (updates.model !== undefined) session.model = updates.model ?? undefined;
  if (updates.mode !== undefined) session.mode = updates.mode ?? undefined;

  updatePanelState(chatId, {
    state: serializeState(session),
    updatedAt: Date.now(),
  });

  log.info({ chatId, updates }, "chat pane updated");
  return session;
}

/**
 * Update a chat pane's status.
 */
export function updateChatStatus(chatId: string, status: ChatStatus): void {
  const session = chatSessions.get(chatId);
  if (!session) return;
  session.status = status;

  updatePanelState(chatId, {
    state: serializeState(session),
    updatedAt: Date.now(),
  });
}

export interface ActiveSessionUpdate {
  activeSessionId: string | undefined;
  /**
   * Cached display title for `activeSessionId`. Pass `undefined` to clear
   * (e.g. when the user resets to a new session without a summary yet).
   */
  summary?: string;
  lastModified?: number;
}

/**
 * Update which session the user is currently viewing in this pane.
 * Persisted so refreshing the page restores the same session — and (when
 * provided) the cached title/mtime so first paint avoids a filesystem walk.
 */
export function updateChatActiveSession(
  chatId: string,
  update: string | undefined | ActiveSessionUpdate,
): void {
  const session = chatSessions.get(chatId);
  if (!session) return;

  if (typeof update === "string" || update === undefined) {
    session.activeSessionId = update;
    // Clear cached summary/lastModified when the session changes without
    // us having pre-resolved metadata. The next chats.get will lazily
    // resolve and persist.
    session.activeSessionSummary = undefined;
    session.activeSessionLastModified = undefined;
  } else {
    session.activeSessionId = update.activeSessionId;
    session.activeSessionSummary = update.summary;
    session.activeSessionLastModified = update.lastModified;
  }

  updatePanelState(chatId, {
    state: serializeState(session),
    updatedAt: Date.now(),
  });
}

/**
 * Refresh just the cached summary/lastModified for the chat's active session.
 * Used by the background refresh after `chats.get` to keep the persisted
 * title in sync with the on-disk JSONL when it drifts (e.g. after `/rename`).
 *
 * Returns true if the row was actually updated.
 */
export function updateChatSessionSummary(
  chatId: string,
  sessionId: string,
  summary: string | undefined,
  lastModified: number | undefined,
): boolean {
  const session = chatSessions.get(chatId);
  if (!session) return false;
  // Stale write guard: only apply if the cached row still references the
  // same activeSessionId. Otherwise the user moved on between the read
  // and the refresh and we'd clobber the new state with old data.
  if (session.activeSessionId !== sessionId) return false;
  if (
    session.activeSessionSummary === summary &&
    session.activeSessionLastModified === lastModified
  ) {
    return false;
  }
  session.activeSessionSummary = summary;
  session.activeSessionLastModified = lastModified;

  updatePanelState(chatId, {
    state: serializeState(session),
    updatedAt: Date.now(),
  });
  return true;
}

/**
 * Remove a chat pane. Kills its agent process, removes from DB,
 * the saved layout, and in-memory maps. Emits a `chat-removed` event
 * so any open dashboard can sync its dockview.
 */
export function removeChat(chatId: string): boolean {
  const session = chatSessions.get(chatId);
  if (!session) return false;

  // Kill agent process
  removeAgent(chatId);

  // Remove from DB
  deletePanelState(chatId);

  // Drop the panel from the saved dockview layout. Mirrors what
  // `terminal.kill` and `browsers.remove` do via their respective
  // `remove*FromLayout` helpers — keeps the layout in sync with
  // the registry so an open dashboard doesn't show a ghost tab.
  removeChatFromLayout(session.workspaceId, chatId);

  // Remove from in-memory maps
  removeFromIndex(chatId);

  // Notify any open dashboard. Same pattern as `browser-removed` /
  // `terminal-killed`.
  emit({ kind: "chat-removed", workspaceId: session.workspaceId, chatId });

  log.info({ chatId, workspaceId: session.workspaceId }, "chat pane removed");
  return true;
}

/**
 * Remove all chat panes for a workspace.
 * Called when a workspace is deleted.
 */
export function removeWorkspaceChats(workspaceId: string): void {
  const ids = workspaceChats.get(workspaceId);
  if (!ids) return;

  for (const chatId of [...ids]) {
    removeAgent(chatId);
    chatSessions.delete(chatId);
  }

  // Bulk delete chat panel states from DB
  deletePanelStatesForWorkspace(workspaceId, PANEL_TYPE);

  workspaceChats.delete(workspaceId);
  log.info({ workspaceId }, "all chat panes removed for workspace");
}

/**
 * Load all chat panes from the database into the in-memory registry.
 * Called on server startup. Resets all statuses to "idle" since no agent
 * can be running when the server just started.
 */
export function loadChatsFromDb(): number {
  _initialized = true; // Mark as initialized so ensureInitialized() is a no-op
  const rows = listPanelStates(PANEL_TYPE);
  const now = Date.now();

  for (const row of rows) {
    const parsed = JSON.parse(row.state) as ChatPanelState;

    // Reset status to idle on startup
    parsed.status = "idle";
    updatePanelState(row.id, {
      state: JSON.stringify(parsed),
      updatedAt: now,
    });

    const session: ChatSession = {
      id: row.id,
      workspaceId: row.workspaceId,
      name: parsed.name,
      agent: parsed.agent,
      model: parsed.model ?? undefined,
      mode: parsed.mode ?? undefined,
      activeSessionId: parsed.activeSessionId ?? undefined,
      activeSessionSummary: parsed.activeSessionSummary ?? undefined,
      activeSessionLastModified: parsed.activeSessionLastModified ?? undefined,
      status: "idle",
    };
    addToIndex(session);
  }

  if (rows.length > 0) {
    log.info({ count: rows.length }, "loaded chat panes from database");
  }
  return rows.length;
}

/**
 * Get or create a default chat pane for a workspace.
 *
 * Resolution order:
 *   1. The active panel from the saved chat layout (e.g. the tab the user
 *      last focused in the dashboard). This makes CLI commands like
 *      `band chat ...` target the same chat the user is looking at.
 *   2. The first chat panel in the saved layout, even if not active.
 *   3. The first chat in the in-memory registry (insertion order).
 *   4. A freshly-created "Chat" panel if the workspace has none yet.
 *
 * Used by the CLI (`band chat`), cronjobs, and tRPC routes that accept an
 * optional chatId — all of them want a single deterministic answer to
 * "which chat does this workspace mean by default".
 */
export function getOrCreateDefaultChat(workspaceId: string): ChatSession {
  const chats = listChats(workspaceId);

  if (chats.length > 0) {
    const layout = getChatLayout(workspaceId);
    const layoutDefault = defaultPanelIdFromLayout(layout);
    if (layoutDefault) {
      const match = chats.find((c) => c.id === layoutDefault);
      if (match) return match;
    }
    return chats[0];
  }

  return createChat(workspaceId, { name: "Chat" });
}
