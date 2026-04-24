/**
 * Chat pane lifecycle management.
 *
 * Each chat pane maps 1:1 to a running agent process on the server.
 * Modeled on terminal-manager.ts — in-memory registry backed by the
 * generic `panel_states` table for persistence across server restarts.
 */

import { createLogger } from "@band-app/logger";
import { removeAgent } from "./agent-pool";
import {
  deletePanelState,
  deletePanelStatesForWorkspace,
  insertPanelState,
  listPanelStates,
  updatePanelState,
} from "./panel-state-store";
import { getAgentDefinition, loadSettings } from "./state";

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

/**
 * Update which session the user is currently viewing in this pane.
 * Persisted so refreshing the page restores the same session.
 */
export function updateChatActiveSession(chatId: string, activeSessionId: string | undefined): void {
  const session = chatSessions.get(chatId);
  if (!session) return;
  session.activeSessionId = activeSessionId;

  updatePanelState(chatId, {
    state: serializeState(session),
    updatedAt: Date.now(),
  });
}

/**
 * Remove a chat pane. Kills its agent process, removes from DB and in-memory maps.
 */
export function removeChat(chatId: string): boolean {
  const session = chatSessions.get(chatId);
  if (!session) return false;

  // Kill agent process
  removeAgent(chatId);

  // Remove from DB
  deletePanelState(chatId);

  // Remove from in-memory maps
  removeFromIndex(chatId);

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
 * Used for backward compatibility when the client hasn't been updated to
 * pass chatId yet — ensures every workspace has at least one chat pane.
 */
export function getOrCreateDefaultChat(workspaceId: string): ChatSession {
  const chats = listChats(workspaceId);
  if (chats.length > 0) return chats[0];
  return createChat(workspaceId, { name: "Chat" });
}
