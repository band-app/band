import { createLogger } from "@band-app/logger";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { listWorktrees } from "../../infra/git/git-client";
// TODO(#319 / Phase 8 follow-up): these legacy `lib/*` imports plus the
// inline worktree-filter / aggregation / sort logic in `resourcesProjects`
// and `resourcesProjectSize` are a layering bypass — the architecture doc
// puts business logic in the services tier. Lifted as-is from the legacy
// `servicesRouter` to keep the wire surface identical during Phase 7.5;
// a follow-up should move the orchestration into
// `SystemService.listProjectResources(...)` / `getProjectResourceSize(...)`
// (mirroring `tunnel/router.ts`, `cli/router.ts`, `editor/router.ts`) and
// fold `branch-status-poller` into a `StatusService`. The same pattern
// applies to `statuses/`, `skills/`, `modes/`, `models/` — see
// `apps/web/src/server/api/router.ts` for the consolidated checklist.
import { getPollerActivity, setPollerActivity } from "../../services/branch-status-poller";
import { loadState } from "../../services/state";
import { systemService } from "../../services/system-service";
import { tunnelService } from "../../services/tunnel-service";
import { publicProcedure, t } from "../trpc";

const log = createLogger("trpc.system");

/**
 * System-wide sub-router — migrated from the legacy `servicesRouter`
 * (lived inline in `apps/web/src/trpc/router.ts`) as part of Phase 7.5
 * (issue #517).
 *
 * The procedures group server-level state that does not belong to any one
 * workspace / project: liveness probes (`health`), the branch-status
 * poller activity dial that the Electron main process drives from
 * window-focus and power-state events (`setActivity` / `getActivity`),
 * and the read-only Resources dashboard endpoints that snapshot the
 * server's CPU/memory plus per-project disk usage.
 *
 * Renamed from `services` → `system` to follow the 3-tier convention
 * (`<domain>/router.ts` exporting `<domain>Router`). The wire surface is
 * preserved by mounting this router as `services:` in the merged root
 * router (`server/api/router.ts`) — every existing client (TunnelDialog,
 * use-tunnel, ResourcesPage, the desktop activity monitor, the CLI) keeps
 * calling `trpc.services.*` without change.
 */
export const systemRouter = t.router({
  /**
   * Combined liveness probe — webserver is always true if this query
   * resolves, plus the current tunnel state. The dashboard polls this on
   * an interval to drive the bottom-bar status pill.
   */
  health: publicProcedure.query(() => {
    log.debug("services.health called");
    const tunnel = tunnelService.getStatus();
    log.debug({ tunnel }, "services.health: tunnel status");
    const result = {
      webserver: true,
      tunnel: tunnel.running,
      tunnel_url: tunnel.url,
    };
    log.debug({ result }, "services.health result");
    return result;
  }),

  // Activity level controls how often the branch-status poller fires.
  // Driven by the Electron main process based on window focus + power state.
  // See `apps/desktop/src/main/services/activity-monitor.ts`.
  setActivity: publicProcedure
    .input(z.object({ activity: z.enum(["active", "idle", "background"]) }))
    .mutation(({ input }) => {
      setPollerActivity(input.activity);
      return { activity: input.activity };
    }),

  getActivity: publicProcedure.query(() => ({ activity: getPollerActivity() })),

  // Resources dashboard — server CPU/memory snapshot (cheap, instant).
  // `process.cpuUsage()` is cumulative since process start; the UI labels
  // it "Total CPU time" so callers don't read it as instantaneous load.
  resourcesServer: publicProcedure.query(() => {
    const mem = process.memoryUsage();
    const cpu = process.cpuUsage();
    return {
      pid: process.pid,
      uptimeSeconds: process.uptime(),
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      memory: {
        rssBytes: mem.rss,
        heapTotalBytes: mem.heapTotal,
        heapUsedBytes: mem.heapUsed,
        externalBytes: mem.external,
        arrayBuffersBytes: mem.arrayBuffers,
      },
      cpu: {
        userMicros: cpu.user,
        systemMicros: cpu.system,
      },
    };
  }),

  // Resources dashboard — list every tracked git project + its
  // worktree paths *without* doing any disk walks. Instant: just
  // reads state + a single `git worktree list --porcelain` per
  // project (in parallel). The client uses this to paint rows
  // immediately, then fetches each project's size individually
  // via `resourcesProjectSize` so the slow `du` work is amortised
  // and observable per-row.
  resourcesProjects: publicProcedure.query(async () => {
    const state = loadState();
    const projects = await Promise.all(
      state.projects
        .filter((p) => p.kind === "git")
        .map(async (project) => {
          try {
            const list = await listWorktrees(project.path);
            // `listWorktrees` guarantees a non-empty branch for non-bare
            // worktrees: detached HEADs (mid-rebase, mid-bisect, or
            // explicit `git checkout <sha>`) are labelled with the
            // rebase head-name when available, otherwise
            // `detached-<short-sha>`. So every row here has a real
            // label and gets counted in the disk accounting.
            const worktrees = list
              .filter((wt) => !wt.isBare)
              .map((wt) => ({ branch: wt.branch, path: wt.path }));
            return {
              project: project.name,
              path: project.path,
              worktrees,
              error: undefined as string | undefined,
            };
          } catch (err) {
            return {
              project: project.name,
              path: project.path,
              worktrees: [] as { branch: string; path: string }[],
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }),
    );
    return { projects };
  }),

  // Resources dashboard — measure disk usage for a single project.
  //
  // Slow: runs `du -sk` once per worktree, in parallel via
  // Promise.all. The client fan-outs are concurrency-limited so the
  // server doesn't see a thundering herd of `du` processes from a
  // single page open. Per-worktree errors are absorbed into the
  // response (sizeBytes 0, `error` populated) so a single broken
  // worktree doesn't fail the whole query.
  resourcesProjectSize: publicProcedure
    .input(z.object({ project: z.string() }))
    .query(async ({ input }) => {
      const state = loadState();
      const project = state.projects.find((p) => p.name === input.project && p.kind === "git");
      if (!project) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Project not found" });
      }

      let worktreePaths: { branch: string; path: string }[];
      try {
        const list = await listWorktrees(project.path);
        // See `resourcesProjects` above — `listWorktrees` already
        // gives every non-bare worktree a non-empty branch label.
        worktreePaths = list
          .filter((wt) => !wt.isBare)
          .map((wt) => ({ branch: wt.branch, path: wt.path }));
      } catch (err) {
        return {
          project: project.name,
          sizeBytes: 0,
          worktrees: [] as Array<{
            branch: string;
            path: string;
            sizeBytes: number;
            error?: string;
          }>,
          error: err instanceof Error ? err.message : String(err),
        };
      }

      const worktrees = await Promise.all(
        worktreePaths.map(async (wt) => {
          try {
            const sizeBytes = await systemService.duBytes(wt.path);
            return { branch: wt.branch, path: wt.path, sizeBytes };
          } catch (err) {
            return {
              branch: wt.branch,
              path: wt.path,
              sizeBytes: 0,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }),
      );

      worktrees.sort((a, b) => b.sizeBytes - a.sizeBytes);
      const sizeBytes = worktrees.reduce((sum, wt) => sum + wt.sizeBytes, 0);
      return { project: project.name, sizeBytes, worktrees };
    }),
});

export type SystemRouter = typeof systemRouter;
