import { randomUUID } from "node:crypto";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { terminalService } from "../../services/terminal-service";
import { emit } from "../../services/watcher-service";
import { publicProcedure, t } from "../trpc";
import { stripTerminalQueries } from "./strip-queries";

/**
 * Terminal sub-router — migrated into the 3-tier architecture as part of
 * Phase 7 (issue #318). Procedures are intentionally thin: validate with
 * Zod, delegate to `TerminalService`, return.
 *
 * The wire shape (procedure names + input/output) is preserved exactly to
 * keep the dashboard and any external consumers backwards-compatible
 * across the lift. The router covers the `terminal` key — PTY lifecycle,
 * scrollback, and the live stream. (The former `terminalLayout` dockview
 * layout-tree CRUD was retired once clients moved center-layout
 * persistence into localStorage — issue #643 Phase 4.)
 */

const terminalRouter = t.router({
  list: publicProcedure.input(z.object({ workspaceId: z.string() })).query(({ input }) => {
    return { terminals: terminalService.list(input.workspaceId) };
  }),

  create: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        // Constrain to a UUID: every caller (the dashboard's
        // `newTerminalId()` and the server's `randomUUID()` fallback)
        // already sends one, and it stops a hostile id from being used
        // anywhere the pool derives a filesystem path from it.
        id: z.string().uuid().optional(),
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
      // Strip query/report escape sequences here too (band-app/band#613):
      // this scrollback fetch has no live-terminal handshake, so a stale
      // color/cursor/DA query in it is pure noise, and any client that renders
      // the result through a terminal emulator would hit the same OSC leak the
      // replay paths do. Stripping is safe — these sequences carry no display
      // value in a point-in-time scrollback read.
      return { output: stripTerminalQueries(output) };
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

      // Register the live-output queue BEFORE serializing. `serialize`
      // pauses the PTY synchronously in this same tick, so no chunk can be
      // double-delivered (queued AND baked into the snapshot); every chunk
      // emitted after the drain's resume lands in the queue — including
      // ones arriving while the snapshot `yield` below is suspended waiting
      // on the consumer. Subscribing after that yield would silently drop
      // them.
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
        // Replay a serialized reconstruction of the terminal state first,
        // same as the `/terminal` WebSocket path: the raw scrollback tail
        // can be cut mid-escape-sequence and garble TUI apps drawn with
        // relative cursor motion. Query/report escapes are still stripped
        // (band-app/band#613) — serialize shouldn't emit them, but the
        // guard is cheap and keeps this path aligned with the WS replay.
        if (replay) {
          const snapshot = await terminalService.serialize(terminalId);
          if (snapshot) {
            yield { type: "output" as const, data: stripTerminalQueries(snapshot) };
          }
        }

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

/**
 * Composite export so the root API router (`server/api/router.ts`) can
 * merge the `terminal` key in a single step. Keeping it as a grouped
 * object also means future additions land in one obvious place.
 */
export const terminalsRouters = {
  terminal: terminalRouter,
};

export type TerminalRouter = typeof terminalRouter;
