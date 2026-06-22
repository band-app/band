import { z } from "zod";
import { getWorkspaceStatus, loadState, upsertWorkspaceStatus } from "../../services/state";
import { taskService } from "../../services/task-service";
import { emit, type WatcherService, watcherService } from "../../services/watcher-service";
import { publicProcedure, t } from "../trpc";

/**
 * Status sub-routers — migrated into the 3-tier architecture as part of
 * Phase 7.5 (issue #517).
 *
 * Two sub-routers live together because they share the same domain (the
 * "agent status" per workspace + the SSE stream of status updates):
 *
 *   - `statusesRouter` — CRUD-ish surface: get one workspace's status,
 *     upsert from the dashboard, clear the "needs attention" indicator
 *     once the user has acknowledged it, and resolve a cwd to a known
 *     workspace.
 *   - `statusRouter`   — the long-lived SSE stream that drives the
 *     dashboard's per-workspace status pills.
 *
 * The merged root router (`server/api/router.ts`) exposes them as
 * `statuses.*` and `status.*` respectively; this file owns both halves
 * because splitting them across two directories would lose the shared
 * `lib/watcher` imports and the documented relationship between them.
 *
 * The legacy declarations lived inline in `apps/web/src/trpc/router.ts`.
 */
export const statusesRouter = t.router({
  get: publicProcedure.input(z.object({ workspaceId: z.string() })).query(({ input }) => {
    return getWorkspaceStatus(input.workspaceId);
  }),

  update: publicProcedure
    .input(
      z.object({
        workspaceId: z.string(),
        agent: z.object({
          status: z.string(),
          lastActivity: z.string().optional(),
        }),
      }),
    )
    .mutation(({ input }) => {
      const status = upsertWorkspaceStatus(input.workspaceId, input.agent);

      // Emit update directly to SSE listeners
      emit({ kind: "update", status });

      return { ok: true };
    }),

  clearNeedsAttention: publicProcedure
    .input(z.object({ workspaceId: z.string() }))
    .mutation(({ input }) => {
      const existing = getWorkspaceStatus(input.workspaceId);
      if (existing?.agent?.status !== "needs_attention") {
        if (existing) {
          emit({ kind: "update", status: existing });
        }
        return { ok: true };
      }
      // The agent is still blocked on an AskUserQuestion / ExitPlanMode
      // prompt — the user hasn't answered yet. Don't clear the indicator
      // just because they navigated to the workspace; the indicator must
      // stay on until the user actually answers (which calls
      // resolvePendingInput, and onUserInputNeeded then flips the status
      // back to "working").
      if (taskService.hasPendingInputForWorkspace(input.workspaceId)) {
        emit({ kind: "update", status: existing });
        return { ok: true };
      }
      const status = upsertWorkspaceStatus(input.workspaceId, { status: "waiting" });
      emit({ kind: "update", status });
      return { ok: true };
    }),

  resolve: publicProcedure.input(z.object({ cwd: z.string() })).query(({ input }) => {
    const state = loadState();
    for (const proj of state.projects) {
      for (const wt of proj.worktrees) {
        if (input.cwd === wt.path || input.cwd.startsWith(`${wt.path}/`)) {
          return { workspaceId: wt.id };
        }
      }
    }
    return { workspaceId: null };
  }),
});

export const statusRouter = t.router({
  stream: publicProcedure.subscription(async function* (opts) {
    type QueueItem = Parameters<Parameters<WatcherService["subscribe"]>[0]>[0];
    const queue: QueueItem[] = [];
    let resolve: (() => void) | null = null;

    const unsubscribe = watcherService.subscribe((event) => {
      queue.push(event);
      resolve?.();
    });

    opts.signal?.addEventListener("abort", () => {
      unsubscribe();
      resolve?.();
    });

    try {
      while (!opts.signal?.aborted) {
        while (queue.length > 0) {
          yield queue.shift()!;
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

export type StatusesRouter = typeof statusesRouter;
export type StatusRouter = typeof statusRouter;
