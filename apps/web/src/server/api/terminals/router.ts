import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { terminalService } from "../../services/terminal-service";
import { emit } from "../../services/watcher-service";
import { publicProcedure, t } from "../trpc";

/**
 * Terminal sub-router — migrated into the 3-tier architecture as part of
 * Phase 7 (issue #318). Procedures are intentionally thin: validate with
 * Zod, delegate to `TerminalService`, return.
 *
 * The wire shape (procedure names + input/output) is preserved exactly to
 * keep the dashboard and any external consumers backwards-compatible
 * across the lift. The router used to live inline in
 * `apps/web/src/trpc/router.ts` under two keys:
 *
 *   - `terminal`         → PTY lifecycle, scrollback, live stream
 *   - `terminalLayout`   → dockview layout tree CRUD
 *
 * Both are re-exported here as separate routers and re-merged at the
 * `server/api/router.ts` entry point so the legacy keys keep working.
 */

const terminalRouter = t.router({
  list: publicProcedure.input(z.object({ workspaceId: z.string() })).query(({ input }) => {
    return { terminals: terminalService.list(input.workspaceId) };
  }),

  create: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        id: z.string().optional(),
        command: z.string().optional(),
        cwd: z.string().optional(),
        env: z.record(z.string()).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const terminalId = input.id ?? randomUUID();
      // `terminalService.spawn` resolves the workspace, asks the pool to
      // fork the PTY, and registers the new terminal in the saved
      // dockview layout. The event emit stays here so the WebSocket
      // spawn path (which goes through the same service method) doesn't
      // double-broadcast.
      const session = await terminalService.spawn(input.workspaceId, terminalId, {
        command: input.command,
        cwd: input.cwd,
        env: input.env,
      });
      emit({ kind: "terminal-created", workspaceId: input.workspaceId, terminalId });
      return { terminalId, workspaceId: input.workspaceId, pid: session.pty.pid };
    }),

  send: publicProcedure
    .input(z.object({ terminalId: z.string(), data: z.string() }))
    .mutation(({ input }) => {
      const ok = terminalService.write(input.terminalId, input.data);
      if (!ok) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Terminal not found: ${input.terminalId}`,
        });
      }
      return { ok: true };
    }),

  output: publicProcedure
    .input(z.object({ terminalId: z.string(), lines: z.number().int().positive().optional() }))
    .query(({ input }) => {
      const output = terminalService.getScrollback(input.terminalId, input.lines ?? undefined);
      if (output == null) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Terminal not found: ${input.terminalId}`,
        });
      }
      return { output };
    }),

  kill: publicProcedure.input(z.object({ terminalId: z.string() })).mutation(({ input }) => {
    terminalService.kill(input.terminalId);
    return { ok: true };
  }),

  stream: publicProcedure
    .input(
      z.object({
        terminalId: z.string(),
        replay: z.boolean().optional().default(true),
      }),
    )
    .subscription(async function* (opts) {
      const { terminalId, replay } = opts.input;

      // Check if terminal exists
      const session = terminalService.getSession(terminalId);
      if (!session) {
        yield { type: "error" as const, data: `Terminal not found: ${terminalId}` };
        return;
      }

      // Replay buffered scrollback first
      if (replay && session.scrollback.length > 0) {
        yield { type: "output" as const, data: session.scrollback };
      }

      // Stream live output
      const queue: string[] = [];
      let resolve: (() => void) | null = null;

      const unsubscribe = terminalService.subscribeOutput(terminalId, (data: string) => {
        queue.push(data);
        resolve?.();
      });

      opts.signal?.addEventListener("abort", () => {
        unsubscribe();
        resolve?.();
      });

      try {
        while (!opts.signal?.aborted) {
          while (queue.length > 0) {
            yield { type: "output" as const, data: queue.shift()! };
          }

          // Check if terminal is still alive
          if (!terminalService.getSession(terminalId)) {
            yield { type: "exit" as const };
            return;
          }

          await new Promise<void>((r) => {
            resolve = r;
          });
          resolve = null;
        }
      } finally {
        unsubscribe();
      }
    }),
});

const terminalLayoutRouter = t.router({
  get: publicProcedure.input(z.object({ workspaceId: z.string() })).query(({ input }) => {
    return { tree: terminalService.getLayout(input.workspaceId) };
  }),

  save: publicProcedure
    .input(z.object({ workspaceId: z.string(), tree: z.unknown() }))
    .mutation(({ input }) => {
      terminalService.saveLayout(input.workspaceId, input.tree);
      return { ok: true };
    }),
});

/**
 * Composite export so the root API router (`server/api/router.ts`) can
 * merge both legacy keys (`terminal` and `terminalLayout`) in a single
 * step. Keeping them as a single grouped object also means future
 * additions land in one obvious place.
 */
export const terminalsRouters = {
  terminal: terminalRouter,
  terminalLayout: terminalLayoutRouter,
};

export type TerminalRouter = typeof terminalRouter;
export type TerminalLayoutRouter = typeof terminalLayoutRouter;
