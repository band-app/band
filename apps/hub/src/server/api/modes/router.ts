import { z } from "zod";
import { agentSessionService } from "../../services/agent-session-service";
import { publicProcedure, t } from "../trpc";

/**
 * Modes sub-router: the execution modes an agent offers (Claude Code's
 * `default` / `acceptEdits` / `plan`, Codex's sandbox levels, …), for the
 * Tasks page's new-task dialog.
 *
 * Over ACP a mode is a session config option (category `mode`), or legacy
 * session mode state for agents without one (issue #648). Read from the
 * agent catalog, which the boot-time probe and every chat session fill; a
 * chat pane reads its live modes from its event stream instead.
 */
export const modesRouter = t.router({
  list: publicProcedure.input(z.object({ agentId: z.string().optional() })).query(({ input }) => ({
    modes: agentSessionService.listModes(input.agentId).map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description,
    })),
  })),
});

export type ModesRouter = typeof modesRouter;
