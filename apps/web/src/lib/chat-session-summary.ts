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
import { getOrCreateAgent } from "../server/infra/agents/agent-pool";
import { type ChatSession, getChat, updateChatSessionSummary } from "./chat-manager";

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

    // No activeSessionId. Leave it null.
    //
    // The legacy code path used `agent.getLatestSession` here to promote
    // the most-recently-modified session on disk as the active one — a
    // useful default when first opening a workspace with prior sessions.
    // That fallback breaks the "New session" flow under the event-log
    // model: handleNewSession clears activeSessionId to null, the
    // subsequent chats.get refetch fires this fallback, and the prior
    // session gets re-promoted before the new task even starts.
    //
    // Under the event-log model the client subscribes to
    // `/api/chats/:chatId/events?workspaceId=...`, which handles JSONL
    // backfill server-side from chat.activeSessionId. When activeSessionId
    // is null, the server returns an empty replay — exactly the right
    // behaviour for a "new session" or never-touched chat. See issue #478.
    return chat;
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

    // No activeSessionId. Leave it null — the same rationale as in
    // `ensureActiveSessionSummary` above applies to the background path
    // too: re-promoting the mtime-newest on-disk session breaks the
    // "New session" flow under the event-log model. After clearing
    // chat.activeSessionId, this fire-and-forget refresh would race
    // against the user's intent and re-resurrect the prior session.
    // Discovery of prior sessions is now an explicit user action via
    // the history dropdown (`sessions.list`). See issue #478.
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
