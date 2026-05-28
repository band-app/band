/**
 * Agent service — thin pass-throughs over the agent pool for the API tier.
 *
 * Routers must not import from `infra/` directly (see
 * `docs/web-architecture.md`). The various agent-driven endpoints (skills
 * list, modes list, models list, session-info lookup, ad-hoc commit
 * message generation, runtime agent switching) all need a `CodingAgent`
 * instance; this module is the single service-tier seam they go through
 * so the pool stays an infra detail.
 *
 * Other services that already depend on the agent pool internally
 * (`task-service`, `session-service`, `chat-session-summary`,
 * `chat-service`) continue to import the infra module directly — that's
 * an allowed Service → Infra dependency. The wrappers here exist purely
 * so the API tier doesn't have to.
 */

import type { CodingAgent } from "@band-app/coding-agent";
import {
  createMetadataAgent as createMetadataAgentImpl,
  createWorkspaceAgent as createWorkspaceAgentImpl,
  getOrCreateAgent as getOrCreateAgentImpl,
  replaceAgent as replaceAgentImpl,
} from "../infra/agents/agent-pool";

/**
 * Get or create the pooled agent for a chat pane. The pool is keyed by
 * `chatId`, so all callers sharing a chat pane get the same instance.
 *
 * Used by:
 *   - `skills` router (`agent.listSkills()`)
 *   - `chats.setActiveSession` (`agent.getSessionInfo()`)
 */
export function getOrCreateAgent(
  chatId: string,
  worktreePath: string,
  agentId?: string,
): Promise<CodingAgent> {
  return getOrCreateAgentImpl(chatId, worktreePath, agentId);
}

/**
 * Create a short-lived agent for metadata queries (listModes, listModels).
 * Does NOT add it to the pool — caller should discard after use.
 *
 * Used by the `modes` and `models` routers.
 */
export function createMetadataAgent(agentId?: string): Promise<CodingAgent> {
  return createMetadataAgentImpl(agentId);
}

/**
 * Create a short-lived agent rooted at a workspace's worktree, for one-shot
 * tool-using tasks (e.g. summarising pending changes into a commit message).
 *
 * Used by `workspace.generateCommitMessage`.
 */
export function createWorkspaceAgent(worktreePath: string, agentId?: string): Promise<CodingAgent> {
  return createWorkspaceAgentImpl(worktreePath, agentId);
}

/**
 * Replace the current pooled agent for a chat pane with one using a
 * different config. Aborts the existing agent (if any) before creating
 * the new one.
 *
 * Used by `workspace.switchAgent`.
 */
export function replaceAgent(
  chatId: string,
  worktreePath: string,
  agentId: string,
): Promise<CodingAgent> {
  return replaceAgentImpl(chatId, worktreePath, agentId);
}
