/**
 * `panelFocus.*` sub-router — records and exposes the last-focused panel per
 * type (chat, terminal, browser) for a workspace.
 *
 * The dashboard's inner dockview containers call `set` when the user switches
 * the active chat/terminal/browser tab; the "Add to Chat" / "Add to Terminal"
 * selection-tooltip actions call `get` to resolve which pane should receive the
 * pasted reference. Thin pass-through to `PanelFocusService`.
 */

import { z } from "zod";
import { panelFocusService } from "../../services/panel-focus-service";
import { publicProcedure, t } from "../trpc";

const focusPanelType = z.enum(["chat", "terminal", "browser"]);

export const panelFocusRouter = t.router({
  get: publicProcedure.input(z.object({ workspaceId: z.string() })).query(({ input }) => {
    return panelFocusService.get(input.workspaceId);
  }),

  set: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        panelType: focusPanelType,
        panelId: z.string(),
      }),
    )
    .mutation(({ input }) => {
      panelFocusService.set(input.workspaceId, input.panelType, input.panelId);
      return { ok: true };
    }),
});

export type PanelFocusRouter = typeof panelFocusRouter;
