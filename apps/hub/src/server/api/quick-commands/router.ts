/**
 * `quickCommands.*`: saved commands a person runs from the tab bar, a terminal's menu or the phone.
 * Any device token may use them. They are left out of the MCP endpoint and the worker relay, so an
 * agent cannot read or plant a command that a person would later run.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { QuickCommandInvalidError, QuickCommandNotFoundError } from "../../errors";
import {
  QUICK_COMMAND_LABEL_MAX,
  QUICK_COMMAND_TEXT_MAX,
  quickCommandService,
} from "../../services/quick-command-service";
import { publicProcedure, t } from "../trpc";

// The service owns the messages for empty and oversized text; the schema only bounds the payload.
const input = z.discriminatedUnion("action", [
  z.object({
    label: z.string().max(QUICK_COMMAND_LABEL_MAX * 4),
    repo: z.string().nullable(),
    action: z.literal("terminal"),
    command: z.string().max(QUICK_COMMAND_TEXT_MAX * 4),
    appendEnter: z.boolean().default(true),
  }),
  z.object({
    label: z.string().max(QUICK_COMMAND_LABEL_MAX * 4),
    repo: z.string().nullable(),
    action: z.literal("agent"),
    agentId: z.string().max(200),
    prompt: z.string().max(QUICK_COMMAND_TEXT_MAX * 4),
  }),
]);

function rethrow(err: unknown): never {
  if (err instanceof QuickCommandNotFoundError) {
    throw new TRPCError({ code: "NOT_FOUND", message: err.message });
  }
  if (err instanceof QuickCommandInvalidError) {
    throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
  }
  throw err;
}

export const quickCommandsRouter = t.router({
  list: publicProcedure.query(() => ({ commands: quickCommandService.list() })),

  create: publicProcedure.input(input).mutation(({ input }) => {
    try {
      return { command: quickCommandService.create(input) };
    } catch (err) {
      rethrow(err);
    }
  }),

  update: publicProcedure
    .input(z.object({ id: z.string(), command: input }))
    .mutation(({ input }) => {
      try {
        return { command: quickCommandService.update(input.id, input.command) };
      } catch (err) {
        rethrow(err);
      }
    }),

  remove: publicProcedure.input(z.object({ id: z.string() })).mutation(({ input }) => {
    try {
      quickCommandService.remove(input.id);
      return { ok: true };
    } catch (err) {
      rethrow(err);
    }
  }),

  /** Records a run so the command moves to the top of the menus. */
  markRun: publicProcedure.input(z.object({ id: z.string() })).mutation(({ input }) => {
    try {
      quickCommandService.markRun(input.id);
      return { ok: true };
    } catch (err) {
      rethrow(err);
    }
  }),
});
