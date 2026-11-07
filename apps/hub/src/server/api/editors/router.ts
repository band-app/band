import { z } from "zod";
import { editorRegistryService } from "../../services/editor-registry-service";
import { publicProcedure, t } from "../trpc";

/**
 * `editors.*`: the window side of agent access to extension editors. A window registers the
 * editor tabs it has open, reports the person's selection, and answers the calls the hub sends
 * into a tab. Device tokens only: the worker relay and the MCP endpoint leave the router out, so
 * an agent reaches a tab through the `band` MCP server's tools and nothing else.
 */
const clientId = z.string().min(1).max(64);
const tabInput = z.object({
  clientId,
  worktreeId: z.string().min(1).max(500),
  file: z.string().min(1).max(2000),
  extensionId: z.string().min(1).max(64),
  editorId: z.string().min(1).max(64),
});

const MAX_TEXT = 4096;

const selectionSchema = z.object({
  address: z.string().max(1000),
  kind: z.string().max(64),
  label: z.string().max(300),
  text: z
    .string()
    .optional()
    .transform((s) => (s !== undefined && s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s)),
  rect: z
    .object({
      x: z.number().finite(),
      y: z.number().finite(),
      width: z.number().finite(),
      height: z.number().finite(),
    })
    .optional(),
});

export const editorsRouter = t.router({
  register: publicProcedure
    .input(tabInput.extend({ dirty: z.boolean().optional() }))
    .mutation(({ input }) => {
      editorRegistryService.register({ ...input, dirty: input.dirty === true });
      return { ok: true as const };
    }),
  unregister: publicProcedure
    .input(tabInput.omit({ editorId: true }).extend({ reason: z.literal("closed").optional() }))
    .mutation(({ input }) => {
      const { reason, ...tab } = input;
      editorRegistryService.unregister(tab, reason);
      return { ok: true as const };
    }),
  result: publicProcedure
    .input(
      z.object({
        clientId,
        callId: z.string().min(1).max(100),
        message: z.record(z.unknown()),
      }),
    )
    .mutation(({ input }) => ({
      accepted: editorRegistryService.result(input.clientId, input.callId, input.message),
    })),
  setSelection: publicProcedure
    .input(tabInput.extend({ selection: selectionSchema.nullable() }))
    .mutation(({ input }) => {
      const { selection, ...tab } = input;
      editorRegistryService.setSelection(tab, selection);
      return { ok: true as const };
    }),
  selection: publicProcedure
    .input(z.object({ worktreeId: z.string().min(1).max(500) }))
    .query(({ input }) => editorRegistryService.selection(input.worktreeId)),
});
