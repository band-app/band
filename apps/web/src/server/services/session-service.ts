import type { SessionListItem } from "@band-app/coding-agent";
import { createLogger } from "@band-app/logger";
import { WorkspaceNotFoundError } from "../errors";
import { getOrCreateAgent } from "../infra/agents/agent-pool";
import { chatService } from "./chat-service";
import { workspaceService } from "./workspace-service";

const log = createLogger("session-service");

/**
 * Per-agent session listing (Phase 6 of the 3-tier refactor — issue #317).
 *
 * Sessions are owned by the coding-agent SDKs (Claude Code, Codex, Gemini,
 * OpenCode, Cursor); Band itself does not persist a session row. This
 * service is a thin façade that resolves the right agent for a workspace +
 * chat pair and delegates to its `listSessions` capability.
 *
 * Per `docs/web-architecture.md`, the API tier
 * (`server/api/sessions/router.ts`) delegates here; the service tier
 * imports infra (`agent-pool`) but never the API tier.
 *
 * The chat-events stream (`apps/web/src/api/chat-events.ts`) handles all
 * other read paths — JSONL backfill via the agent's `getSessionMessages`,
 * live tail via `TaskService.subscribe`, gap-fill via
 * `getSessionEventsAfter`. This file intentionally stays narrow: it covers
 * only the explicit "list past sessions for this workspace" request.
 */

// ---------------------------------------------------------------------------
// Service-level error types
//
// Surface conditions the API tier needs to translate into HTTP/tRPC error
// codes. The actual class lives in `server/errors.ts` (one canonical copy
// shared by every workspace-owning service); we re-export it here so legacy
// imports through the service module keep working. See `errors.ts` for the
// rationale on why three duplicate classes existed before this change and
// what they collapse into.
// ---------------------------------------------------------------------------

export { WorkspaceNotFoundError };

/**
 * Shape of a single session returned by `SessionService.list`.
 *
 * Re-exports the coding-agent's `SessionListItem` unchanged so the dashboard's
 * `SessionHistoryItem` type (which keys on `sessionId`, not `id`) keeps
 * compiling. Renaming the wire shape here is out of scope for the 3-tier
 * migration — the goal is a structural lift, not a contract change.
 *
 * Adapters that don't expose `listSessions` are surfaced via the
 * `supported: false` branch on the list response — the dashboard hides the
 * "past sessions" UI for those agents.
 */
export type SessionSummary = SessionListItem;

export interface ListSessionsResponse {
  sessions: SessionSummary[];
  /**
   * `true` when the resolved agent supports listing sessions, `false`
   * otherwise (e.g. an agent that runs purely transactionally with no
   * persisted sessions). The dashboard uses this to decide whether to
   * render the session picker.
   */
  supported: boolean;
}

export class SessionService {
  /**
   * List past sessions for a workspace's chat pane.
   *
   * Resolves the agent from the chat pane (or default chat when `chatId`
   * is undefined) and forwards to the agent SDK's `listSessions`. Throws
   * `WorkspaceNotFoundError` when the workspace can't be resolved.
   */
  async list(input: { workspaceId: string; chatId?: string }): Promise<ListSessionsResponse> {
    const workspace = workspaceService.resolve(input.workspaceId);
    if (!workspace) {
      throw new WorkspaceNotFoundError(input.workspaceId);
    }

    const chatId = input.chatId ?? chatService.getOrCreateDefault(input.workspaceId).id;
    const chatSession = chatService.get(chatId);
    const agent = await getOrCreateAgent(chatId, workspace.worktree.path, chatSession?.agent);

    if (!agent.supportedFeatures.sessionListing || !agent.listSessions) {
      return { sessions: [], supported: false };
    }

    // Each agent's listSessions() already scopes to the workspace
    // directory — no additional filtering needed. This shows all
    // sessions for the agent type, including ones created outside Band.
    log.debug({ chatId, workspaceId: input.workspaceId }, "listing past sessions for chat");
    const allSessions = await agent.listSessions(workspace.worktree.path);
    return { sessions: allSessions, supported: true };
  }
}

/**
 * Singleton — same pattern as `cronjobService` / `workspaceService`. The
 * API tier imports this directly rather than constructing per-request
 * instances so the service stays compatible with future stateful behavior
 * (caching, in-flight de-dup) without forcing every caller to thread a
 * shared instance.
 */
export const sessionService = new SessionService();
