import { z } from "zod";
import { agentService } from "../../services/agent-service";
import { getChat, getOrCreateDefaultChat } from "../../services/chat-manager";
import { resolveWorkspace } from "../../services/workspace";
import { publicProcedure, t } from "../trpc";

/**
 * Skills sub-router — migrated into the 3-tier architecture as part of
 * Phase 7.5 (issue #517). Returns the list of agent-side skills the
 * currently-bound coding agent exposes for a given workspace/chat pair.
 *
 * The agent (Claude Code, Codex, …) owns the list — this router is a
 * pass-through that picks the right agent instance and delegates to its
 * `listSkills()` method.
 */
export const skillsRouter = t.router({
  list: publicProcedure
    .input(z.object({ workspaceId: z.string(), chatId: z.string().optional() }))
    .query(async ({ input }) => {
      const workspace = resolveWorkspace(input.workspaceId);
      if (!workspace) {
        return { skills: [] };
      }

      const chatId = input.chatId ?? getOrCreateDefaultChat(input.workspaceId).id;
      const chatSession = getChat(chatId);
      const agent = await agentService.getOrCreateAgent(
        chatId,
        workspace.worktree.path,
        chatSession?.agent,
      );
      if (agent.listSkills) {
        const skills = await agent.listSkills();
        return { skills };
      }

      return { skills: [] };
    }),
});

export type SkillsRouter = typeof skillsRouter;
