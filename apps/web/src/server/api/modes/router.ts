import { z } from "zod";
import { agentSessionService } from "../../services/agent-session-service";
import { settingsService } from "../../services/settings-service";
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
  list: publicProcedure.input(z.object({ agentId: z.string().optional() })).query(({ input }) => {
    const def = settingsService.getAgentDefinition(input.agentId);
    const entry = agentSessionService.catalogEntry(def.id);
    if (!entry) return { modes: [] };
    const option = entry.configOptions.find(
      (o) => o.type === "select" && (o.category === "mode" || o.id === "mode"),
    );
    if (option?.type === "select") {
      return {
        modes: option.options
          .flatMap((o) => ("group" in o ? o.options : [o]))
          .map((o) => ({ id: o.value, name: o.name, description: o.description ?? undefined })),
      };
    }
    return {
      modes: (entry.modes?.availableModes ?? []).map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description ?? undefined,
      })),
    };
  }),
});

export type ModesRouter = typeof modesRouter;
