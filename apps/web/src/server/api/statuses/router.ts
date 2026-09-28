import { z } from "zod";
import {
  acknowledgeWorkspaceAttention,
  applyHookNotification,
  chatStatusSource,
  getWorkspaceStatus,
  MANUAL_STATUS_SOURCE,
  resolveWorkspaceIdByCwd,
  setWorkspaceSourceStatus,
} from "../../services/state";
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
      const status = setWorkspaceSourceStatus(input.workspaceId, MANUAL_STATUS_SOURCE, input.agent);

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
      // Every agent asking for attention is acknowledged, except a chat
      // whose agent is still blocked on a permission or elicitation request:
      // the user hasn't answered yet, so navigating to the workspace doesn't
      // clear it. Answering does (task-service flips that chat back to
      // "working").
      const keep = taskService
        .chatsWithPendingInput(input.workspaceId)
        .map((chatId) => chatStatusSource(chatId));
      const status = acknowledgeWorkspaceAttention(input.workspaceId, keep);
      emit({ kind: "update", status });
      return { ok: true };
    }),

  resolve: publicProcedure.input(z.object({ cwd: z.string() })).query(({ input }) => {
    return { workspaceId: resolveWorkspaceIdByCwd(input.cwd) };
  }),

  /**
   * Agent-agnostic entry point for coding-agent lifecycle notifications
   * (e.g. Claude Code hooks piped through `band notify`). The CLI forwards
   * the raw payload plus the agent's cwd, the agent type the hook command
   * names (`--agent`), and its `BAND_DISPATCH` / `BAND_TERMINAL_ID`. The
   * server resolves the workspace and the sending agent, and dispatches to
   * that agent's adapter to translate the payload into a status. Keeping the
   * mapping in the adapter means adding hook support for a new agent never
   * touches the CLI.
   *
   * Fire-and-forget semantics: unknown cwd → no-op `{ ok: true }` (matches the
   * CLI hook contract, which must never fail and break the agent).
   */
  notify: publicProcedure
    .input(
      z.object({
        cwd: z.string(),
        payload: z.record(z.string(), z.unknown()),
        agent: z.string().max(64).optional(),
        dispatch: z.string().max(64).optional(),
        terminalId: z.string().max(256).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const status = await applyHookNotification(input);
      if (status) emit({ kind: "update", status });
      return { ok: true };
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
