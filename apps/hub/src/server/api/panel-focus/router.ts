/**
 * `panelFocus.*` sub-router — records and exposes the last-focused panel per
 * type (chat, terminal, browser) for a worktree.
 *
 * The dashboard's inner dockview containers call `set` when the user switches
 * the active chat/terminal/browser tab; the "Add to Chat" / "Add to Terminal"
 * selection context menu actions call `get` to resolve which pane should receive the
 * pasted reference. Thin pass-through to `PanelFocusService`.
 */

import { z } from "zod";
import { panelFocusService } from "../../services/panel-focus-service";
import { publicProcedure, t } from "../trpc";

const focusPanelType = z.enum(["chat", "terminal", "browser"]);

export const panelFocusRouter = t.router({
  get: publicProcedure.input(z.object({ worktreeId: z.string() })).query(({ input }) => {
    return panelFocusService.get(input.worktreeId);
  }),

  set: publicProcedure
    .input(
      z.object({
        worktreeId: z.string(),
        panelType: focusPanelType,
        panelId: z.string(),
      }),
    )
    .mutation(({ input }) => {
      panelFocusService.set(input.worktreeId, input.panelType, input.panelId);
      return { ok: true };
    }),
});

export type PanelFocusRouter = typeof panelFocusRouter;
