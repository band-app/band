/**
 * Background refresh + fallback resolution for the cached `activeSessionSummary`
 * stored on each chat pane.
 *
 * The chat pane persists `(activeSessionId, activeSessionSummary, activeSessionLastModified)`
 * on the chat row so first paint after a workspace switch is a pure SQLite
 * read — no filesystem walk over `~/.claude/projects/<workspace>/`.
 *
 * This module provides two helpers:
 *
 *   • `ensureActiveSessionSummary(chatId, worktreePath)` — used by `chats.get`
 *     when a row is missing its cached summary (post-migration, or after the
 *     summary has been cleared). Resolves once via `agent.getSessionInfo`,
 *     persists the result, and returns the updated row data so the caller
 *     can return fresh values to the client.
 *
 *   • `scheduleActiveSessionRefresh(chatId, worktreePath)` — fire-and-forget
 *     refresh after a `chats.get` returns. Calls `agent.getSessionInfo` and
 *     UPDATEs the row when the persisted summary/mtime no longer matches
 *     what's on disk. Concurrent calls for the same `chatId` are deduplicated.
 *
 * Both helpers also handle the no-active-session fallback: when the chat row
 * has no `activeSessionId`, they consult `agent.getLatestSession()` (mtime-sorted
 * readdir + single `getSessionInfo`) and persist the result so subsequent
 * reads stay on the pure-SQLite hot path.
 */

import { createLogger } from "@band-app/logger";
import { getOrCreateAgent } from "./agent-pool";
import {
  type ChatSession,
  getChat,
  updateChatActiveSession,
  updateChatSessionSummary,
} from "./chat-manager";

const log = createLogger("chat-session-summary");

/** Per-chatId dedupe map for in-flight refreshes. */
const REFRESH_KEY = Symbol.for("band.chat-session-summary.refresh");
const g = globalThis as unknown as Record<symbol, unknown>;
if (!g[REFRESH_KEY]) g[REFRESH_KEY] = new Map<string, Promise<void>>();
const refreshes = g[REFRESH_KEY] as Map<string, Promise<void>>;

/**
 * Resolve and persist the active-session summary when the chat row is
 * missing one. Used by `chats.get` for the migration / fallback case.
 *
 * Returns the updated chat (or the unchanged input if nothing was resolved).
 */
export async function ensureActiveSessionSummary(
  chatId: string,
  worktreePath: string,
): Promise<ChatSession | undefined> {
  const chat = getChat(chatId);
  if (!chat) return undefined;

  // Already cached — nothing to do.
  if (chat.activeSessionId && chat.activeSessionSummary !== undefined) return chat;

  try {
    const agent = await getOrCreateAgent(chatId, worktreePath, chat.agent);

    if (chat.activeSessionId) {
      // Migration / lazy-resolve case: row has activeSessionId but no
      // cached summary. Resolve once and persist.
      if (!agent.getSessionInfo) return chat;
      const info = await agent.getSessionInfo(chat.activeSessionId, worktreePath);
      if (info) {
        updateChatSessionSummary(chatId, chat.activeSessionId, info.summary, info.lastModified);
      } else {
        // Session file doesn't exist anymore — leave the cached values
        // null. The client will treat this as "no active session" until
        // the next mutation rebuilds the cache.
      }
      return getChat(chatId);
    }

    // Fallback: no activeSessionId on the row at all. Find the latest
    // session by mtime and persist it as the active session.
    if (!agent.getLatestSession) return chat;
    const latest = await agent.getLatestSession(worktreePath);
    if (!latest) return chat;
    updateChatActiveSession(chatId, {
      activeSessionId: latest.sessionId,
      summary: latest.summary,
      lastModified: latest.lastModified,
    });
    return getChat(chatId);
  } catch (err) {
    log.warn({ chatId, err }, "ensureActiveSessionSummary failed");
    return chat;
  }
}

/**
 * Fire-and-forget refresh of the cached summary after a `chats.get` returns.
 * Concurrent calls for the same chatId share a single in-flight refresh —
 * a burst of SSE-driven query refetches won't stampede `agent.getSessionInfo`.
 */
export function scheduleActiveSessionRefresh(chatId: string, worktreePath: string): void {
  if (refreshes.has(chatId)) return;

  const promise = doRefresh(chatId, worktreePath).finally(() => {
    // Only clear if the entry is still ours — defensive, the Map is keyed
    // per-chatId and the only writer here is this function, but kept for
    // symmetry with the agent-pool dedupe pattern.
    const current = refreshes.get(chatId);
    if (current === promise) refreshes.delete(chatId);
  });
  refreshes.set(chatId, promise);
}

async function doRefresh(chatId: string, worktreePath: string): Promise<void> {
  try {
    const chat = getChat(chatId);
    if (!chat) return;

    const agent = await getOrCreateAgent(chatId, worktreePath, chat.agent);

    if (chat.activeSessionId) {
      if (!agent.getSessionInfo) return;
      const info = await agent.getSessionInfo(chat.activeSessionId, worktreePath);
      if (!info) {
        // Session file is gone (deleted, moved, etc.). Don't clobber
        // the cached values — they're still useful for the tab title
        // until the user picks a new session.
        return;
      }
      updateChatSessionSummary(chatId, chat.activeSessionId, info.summary, info.lastModified);
      return;
    }

    // No activeSessionId yet — opportunistically resolve the latest
    // session so the next read is on the pure-SQLite hot path.
    if (!agent.getLatestSession) return;
    const latest = await agent.getLatestSession(worktreePath);
    if (!latest) return;
    // Re-read the chat: a concurrent setActiveSession may have set
    // an activeSessionId in the meantime, which we must not clobber.
    const fresh = getChat(chatId);
    if (!fresh || fresh.activeSessionId) return;
    updateChatActiveSession(chatId, {
      activeSessionId: latest.sessionId,
      summary: latest.summary,
      lastModified: latest.lastModified,
    });
  } catch (err) {
    log.warn({ chatId, err }, "active session refresh failed");
  }
}

/**
 * Test-only: wait for any in-flight refresh for the given chatId.
 * Exposed via a tRPC test endpoint so integration tests can assert
 * post-refresh state without polling.
 */
export async function waitForActiveSessionRefresh(chatId: string): Promise<void> {
  const promise = refreshes.get(chatId);
  if (promise) await promise;
}
