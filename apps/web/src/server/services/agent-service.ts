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
 * (`task-service`, `session-service`, `chat-service`) continue to
 * import the infra module directly — that's an allowed Service → Infra
 * dependency. The wrappers here exist purely so the API tier doesn't
 * have to.
 *
 * Class-with-constructor-DI shape per `docs/web-architecture.md`
 * (issue #535, follow-up 5). The class wraps the agent-pool functions
 * so tests can inject a stub; the exported `agentService` singleton is
 * what the routers consume.
 */

import type { CodingAgent } from "@band-app/coding-agent";
import {
  createMetadataAgent,
  createWorkspaceAgent,
  getOrCreateAgent,
  replaceAgent,
} from "../infra/agents/agent-pool";

/**
 * Infra-level seam the service depends on. The default is the real
 * agent-pool module's function exports; tests can pass a stub map of the
 * same shape (e.g. one that returns a fake CodingAgent) without touching
 * the agent-pool itself.
 */
export interface AgentPoolAdapter {
  getOrCreateAgent: typeof getOrCreateAgent;
  createMetadataAgent: typeof createMetadataAgent;
  createWorkspaceAgent: typeof createWorkspaceAgent;
  replaceAgent: typeof replaceAgent;
}

const DEFAULT_POOL: AgentPoolAdapter = {
  getOrCreateAgent,
  createMetadataAgent,
  createWorkspaceAgent,
  replaceAgent,
};

export class AgentService {
  constructor(private readonly pool: AgentPoolAdapter = DEFAULT_POOL) {}

  /**
   * Get or create the pooled agent for a chat pane. The pool is keyed by
   * `chatId`, so all callers sharing a chat pane get the same instance.
   *
   * Used by:
   *   - `skills` router (`agent.listSkills()`)
   *   - `chats.setActiveSession` (`agent.getSessionInfo()`)
   */
  getOrCreateAgent(chatId: string, worktreePath: string, agentId?: string): Promise<CodingAgent> {
    return this.pool.getOrCreateAgent(chatId, worktreePath, agentId);
  }

  /**
   * Create a short-lived agent for metadata queries (listModes, listModels).
   * Does NOT add it to the pool — caller should discard after use.
   *
   * Used by the `modes` and `models` routers.
   */
  createMetadataAgent(agentId?: string): Promise<CodingAgent> {
    return this.pool.createMetadataAgent(agentId);
  }

  /**
   * Create a short-lived agent rooted at a workspace's worktree, for
   * one-shot tool-using tasks (e.g. summarising pending changes into a
   * commit message).
   *
   * Used by `WorkspaceService.generateCommitMessage`.
   */
  createWorkspaceAgent(worktreePath: string, agentId?: string): Promise<CodingAgent> {
    return this.pool.createWorkspaceAgent(worktreePath, agentId);
  }

  /**
   * Replace the current pooled agent for a chat pane with one using a
   * different config. Aborts the existing agent (if any) before creating
   * the new one.
   *
   * Used by `WorkspaceService.switchAgent`.
   */
  replaceAgent(chatId: string, worktreePath: string, agentId: string): Promise<CodingAgent> {
    return this.pool.replaceAgent(chatId, worktreePath, agentId);
  }
}

export const agentService = new AgentService();
