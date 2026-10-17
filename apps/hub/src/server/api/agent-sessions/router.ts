/**
 * Agent sessions (issue #682): list a worktree's running agent sessions and
 * start new ones. Thin: validates, delegates to `AgentLaunchService` /
 * `AgentSessions`, maps domain errors onto tRPC codes.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { ContinueGateError, WorktreeNotFoundError } from "../../errors";
import { agentLaunchService, ChatNotInWorktreeError } from "../../services/agent-launch-service";
import { agentSessionRegistry } from "../../services/agent-session-registry-service";
import { followService } from "../../services/follow-service";
import { TaskConflictError } from "../../services/task-service";
import { publicProcedure, t } from "../trpc";

export const agentSessionsRouter = t.router({
  list: publicProcedure.input(z.object({ worktreeId: z.string() })).query(({ input }) => {
    return { agentSessions: agentSessionRegistry.listOpen(input.worktreeId) };
  }),

  /**
   * Start an agent. `mode` is the calling device's choice; without it the
   * server's `agents.defaultMode` applies. The response carries the mode
   * actually used, which is `gui` when the agent has no TUI invocation.
   */
  launch: publicProcedure
    .input(
      z.object({
        worktreeId: z.string(),
        agentId: z.string().optional(),
        // Same cap as `worktrees.create`: a `tui` launch embeds the prompt
        // in the PTY command line.
        prompt: z.string().max(100_000).optional(),
        mode: z.enum(["gui", "tui"]).optional(),
        chatId: z.string().max(512).optional(),
        // A UUID like `terminal.create`'s id: the pool derives filesystem
        // paths from it.
        terminalId: z.string().uuid().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      try {
        // An agent needs a live host: continue the work elsewhere, or tell the client its choices.
        const gate = await followService.gate(input.worktreeId, {
          chatId: input.chatId,
          agentId: input.agentId,
        });
        const { ready, ...result } = agentLaunchService.launch({
          worktreeId: gate.worktreeId,
          agentDefinitionId: input.agentId,
          prompt: input.prompt,
          mode: input.mode,
          chatId: input.chatId,
          terminalId: input.terminalId,
        });
        await ready;
        return gate.continued
          ? { ...result, worktreeId: gate.worktreeId, continued: gate.continued }
          : result;
      } catch (err) {
        if (err instanceof ContinueGateError) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: err.message, cause: err });
        }
        if (err instanceof WorktreeNotFoundError) {
          throw new TRPCError({ code: "NOT_FOUND", message: err.message });
        }
        if (err instanceof ChatNotInWorktreeError) {
          throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
        }
        if (err instanceof TaskConflictError) {
          throw new TRPCError({ code: "CONFLICT", message: err.message });
        }
        throw err;
      }
    }),
});
