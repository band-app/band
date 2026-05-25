import { eq } from "drizzle-orm";
import { toWorkspaceId } from "@/dashboard";
import { getDb } from "./db/connection";
import { branchStatuses as branchStatusesTable } from "./db/schema";
import { execGh, execGit, getRepoInfo, type RepoInfo } from "./git";
import { buildBatchedCIQuery, type CIStatus, parseBatchedCIResponse } from "./github-graphql";
import { loadState } from "./state";
import { syncWorktrees } from "./sync-state";
import { emit } from "./watcher";

interface GitStatus {
  dirty: boolean;
  conflict: boolean;
  ahead: number;
  behind: number;
  sync_state: string;
}

interface WorkspaceInfo {
  workspaceId: string;
  project: string;
  branch: string;
  defaultBranch: string;
  worktreePath: string;
  projectPath: string;
  /**
   * Whether the project's git repo has an `origin` remote. Populated
   * from `ProjectState.hasOrigin`, which `syncWorktrees` keeps in sync
   * at the CI tick cadence. Used to skip the CI / GraphQL probe for
   * origin-less repos — see issue #458.
   */
  hasOrigin: boolean;
}

/**
 * Activity level controls how aggressively we poll git/CI status. The Electron
 * main process drives this via the `services.setActivity` tRPC mutation when
 * the window gains/loses focus or the laptop transitions on/off battery —
 * see `apps/desktop/src/main/services/activity-monitor.ts`. Other clients
 * (CLI, web-only deployments) can leave it at the default `"active"`.
 */
export type ActivityLevel = "active" | "idle" | "background";

interface IntervalConfig {
  /** Base tick period in ms — fires `getGitStatus` for every workspace. */
  pollMs: number;
  /** Every Nth tick also runs `git fetch --all` + the batched CI query. */
  ciTicks: number;
}

const INTERVALS: Record<ActivityLevel, IntervalConfig> = {
  // 5 s git / 30 s CI — the original cadence, used when the user is actively looking at the UI on AC power.
  active: { pollMs: 5_000, ciTicks: 6 },
  // 30 s git / 3 min CI — window unfocused OR on battery (but not both).
  idle: { pollMs: 30_000, ciTicks: 6 },
  // 60 s git / 10 min CI — window unfocused AND on battery.
  background: { pollMs: 60_000, ciTicks: 10 },
};

let pollerTimer: ReturnType<typeof setInterval> | null = null;
let tickCount = 0;
let currentActivity: ActivityLevel = "active";

function getWorkspaces(): WorkspaceInfo[] {
  const state = loadState();
  const workspaces: WorkspaceInfo[] = [];
  for (const project of state.projects) {
    // Plain (non-git) projects can't be polled for git/CI status —
    // there's no .git, no remote, no branches. Skipping them here also
    // avoids noisy `git status` / `gh` errors in the server log.
    if (project.kind === "plain") continue;
    for (const wt of project.worktrees) {
      workspaces.push({
        workspaceId: toWorkspaceId(project.name, wt.branch),
        project: project.name,
        branch: wt.branch,
        defaultBranch: project.defaultBranch,
        worktreePath: wt.path,
        projectPath: project.path,
        hasOrigin: project.hasOrigin,
      });
    }
  }
  return workspaces;
}

async function getGitStatus(worktreePath: string): Promise<GitStatus> {
  const status: GitStatus = {
    dirty: false,
    conflict: false,
    ahead: 0,
    behind: 0,
    sync_state: "synced",
  };

  try {
    const porcelain = await execGit(["status", "--porcelain"], worktreePath);
    for (const line of porcelain.split("\n")) {
      if (!line) continue;
      const xy = line.slice(0, 2);
      if (xy === "UU" || xy === "AA" || xy === "DD") {
        status.conflict = true;
      }
      status.dirty = true;
    }
  } catch {
    // git status failed - leave defaults
  }

  try {
    await execGit(["rev-parse", "--abbrev-ref", "@{upstream}"], worktreePath);

    const countOutput = await execGit(
      ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
      worktreePath,
    );
    const parts = countOutput.trim().split(/\s+/);
    if (parts.length === 2) {
      status.ahead = parseInt(parts[0], 10) || 0;
      status.behind = parseInt(parts[1], 10) || 0;
    }

    if (status.ahead > 0 && status.behind > 0) {
      status.sync_state = "diverged";
    } else if (status.ahead > 0) {
      status.sync_state = "ahead";
    } else if (status.behind > 0) {
      status.sync_state = "behind";
    } else {
      status.sync_state = "synced";
    }
  } catch {
    status.sync_state = "untracked";
  }

  return status;
}

/**
 * Fetch CI status for all workspaces using batched GraphQL queries.
 *
 * Groups workspaces by GitHub host and executes one GraphQL query per host,
 * fetching PR status and check suite results for all branches in a single request.
 *
 * The caller is responsible for pre-filtering to workspaces whose project
 * has `hasOrigin === true` (see `ProjectState.hasOrigin`, written by
 * `syncWorktrees`). That removes the no-origin / not-a-git-checkout
 * steady-state failures from this path entirely — no per-tick `getRepoInfo`
 * retry loop, no negative cache, no log spam (issue #458). The
 * `getRepoInfo` call below should therefore succeed in steady state; a
 * failure here is a transient race (origin removed between sync and poll)
 * and is logged at debug.
 */
async function getBatchedCIStatuses(workspaces: WorkspaceInfo[]): Promise<Map<string, CIStatus>> {
  const resolved: Array<{
    ws: WorkspaceInfo;
    repoInfo: RepoInfo;
    alias: string;
  }> = [];
  await Promise.allSettled(
    workspaces.map(async (ws, index) => {
      const repoInfo = await getRepoInfo(ws.projectPath);
      if (repoInfo) {
        resolved.push({ ws, repoInfo, alias: `ws_${index}` });
      }
      // Silent skip on null: `hasOrigin` was true at `getWorkspaces()` time
      // but the probe just now returned null — a transient race after
      // origin was removed externally. `syncWorktrees` will rewrite
      // `hasOrigin` on the next sync tick and steady state resumes.
      // `getRepoInfo` already logged the underlying reason at debug.
    }),
  );

  // If no workspaces have repo info, return empty
  if (resolved.length === 0) {
    const results = new Map<string, CIStatus>();
    for (const ws of workspaces) {
      results.set(ws.workspaceId, { state: "none" });
    }
    return results;
  }

  // Group by GitHub host (one query per host for correct auth)
  const byHost = new Map<string, typeof resolved>();
  for (const entry of resolved) {
    const host = entry.repoInfo.host;
    const group = byHost.get(host) ?? [];
    group.push(entry);
    byHost.set(host, group);
  }

  const allResults = new Map<string, CIStatus>();

  // Execute one batched GraphQL query per host
  for (const [host, group] of byHost) {
    const inputs = group.map((g) => ({
      alias: g.alias,
      branch: g.ws.branch,
      repoInfo: g.repoInfo,
    }));

    const query = buildBatchedCIQuery(inputs);
    // Use any workspace's worktreePath for cwd (gh auth is per-host)
    const cwd = group[0].ws.worktreePath;

    const ghArgs = ["api", "graphql", "-f", `query=${query}`];
    if (host !== "github.com") {
      ghArgs.push("--hostname", host);
    }

    try {
      const output = await execGh(ghArgs, cwd);
      const response = JSON.parse(output) as {
        data: Record<string, unknown>;
      };
      // Build map of alias -> defaultBranch for aliases that are on the default branch
      const defaultBranches = new Map<string, string>();
      for (const g of group) {
        if (g.ws.branch === g.ws.defaultBranch) {
          defaultBranches.set(g.alias, g.ws.defaultBranch);
        }
      }

      const parsed = parseBatchedCIResponse(
        response.data as Record<string, never>,
        inputs.map((i) => i.alias),
        defaultBranches,
      );

      // Map aliases back to workspace IDs
      for (const g of group) {
        const status = parsed.get(g.alias);
        if (status) {
          allResults.set(g.ws.workspaceId, status);
        }
      }
    } catch (err) {
      console.error(
        `CI poll: GraphQL query failed for host (${group.length} workspaces):`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Fill in "none" for workspaces that couldn't resolve repo info
  for (const ws of workspaces) {
    if (!allResults.has(ws.workspaceId)) {
      allResults.set(ws.workspaceId, { state: "none" });
    }
  }

  return allResults;
}

async function pollTick() {
  tickCount++;
  const isCITick = tickCount % INTERVALS[currentActivity].ciTicks === 0;

  if (tickCount === 1 || isCITick) {
    await syncWorktrees().catch((err) => console.error("syncWorktrees error:", err));
  }

  const workspaces = getWorkspaces();

  if (workspaces.length === 0) return;

  // On CI ticks, do git fetch in parallel per unique project path
  if (isCITick) {
    const uniqueProjectPaths = [...new Set(workspaces.map((w) => w.projectPath))];
    await Promise.allSettled(
      uniqueProjectPaths.map((projectPath) =>
        execGit(["fetch", "--quiet", "--all"], projectPath).catch(() => {}),
      ),
    );
  }

  const db = getDb();

  // Fetch CI statuses in batch on CI ticks. Filter to workspaces whose
  // project has an `origin` remote — by construction, an origin-less
  // project has no PR / CI status to report and the GraphQL query would
  // need a `getRepoInfo` probe that's guaranteed to fail (issue #458).
  // `hasOrigin` is maintained by `syncWorktrees`, which runs in the same
  // tick body just above; freshly-discovered origin changes land in the
  // map before this filter reads it.
  let ciStatuses = new Map<string, CIStatus>();
  if (isCITick) {
    const ciWorkspaces = workspaces.filter((w) => w.hasOrigin);
    if (ciWorkspaces.length > 0) {
      ciStatuses = await getBatchedCIStatuses(ciWorkspaces);
    }
  }

  await Promise.allSettled(
    workspaces.map(async (ws) => {
      const git = await getGitStatus(ws.worktreePath);

      let ci: CIStatus = { state: "none" };
      if (isCITick) {
        ci = ciStatuses.get(ws.workspaceId) ?? { state: "none" };
      } else {
        // Preserve existing CI status from DB on non-CI ticks
        const existing = db
          .select({ ciState: branchStatusesTable.ciState, ciUrl: branchStatusesTable.ciUrl })
          .from(branchStatusesTable)
          .where(eq(branchStatusesTable.workspaceId, ws.workspaceId))
          .get();
        if (existing) {
          ci = { state: existing.ciState, url: existing.ciUrl };
        }
      }

      const now = Date.now();

      // Upsert branch status into DB
      db.insert(branchStatusesTable)
        .values({
          workspaceId: ws.workspaceId,
          gitDirty: git.dirty,
          gitConflict: git.conflict,
          gitAhead: git.ahead,
          gitBehind: git.behind,
          gitSyncState: git.sync_state,
          ciState: ci.state,
          ciUrl: ci.url ?? null,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: branchStatusesTable.workspaceId,
          set: {
            gitDirty: git.dirty,
            gitConflict: git.conflict,
            gitAhead: git.ahead,
            gitBehind: git.behind,
            gitSyncState: git.sync_state,
            ciState: ci.state,
            ciUrl: ci.url ?? null,
            updatedAt: now,
          },
        })
        .run();

      // Emit directly to SSE listeners
      emit({
        kind: "branch-status",
        workspaceId: ws.workspaceId,
        git,
        ci,
      });
    }),
  );
}

export function startBranchStatusPoller() {
  if (pollerTimer) return;
  tickCount = 0;

  // Run first tick immediately
  pollTick().catch((err) => console.error("Branch status poll error:", err));

  pollerTimer = setInterval(() => {
    pollTick().catch((err) => console.error("Branch status poll error:", err));
  }, INTERVALS[currentActivity].pollMs);
}

export function stopBranchStatusPoller() {
  if (pollerTimer) {
    clearInterval(pollerTimer);
    pollerTimer = null;
  }
}

/**
 * Update the activity level. If the poller is currently running it is
 * rescheduled with the new base interval; `tickCount` is reset so the new CI
 * cadence is honoured immediately rather than being dragged out by a stale
 * counter from the previous level.
 *
 * No-op when the level is unchanged.
 */
export function setPollerActivity(activity: ActivityLevel): void {
  if (activity === currentActivity) return;
  currentActivity = activity;
  if (pollerTimer) {
    clearInterval(pollerTimer);
    tickCount = 0;
    pollerTimer = setInterval(() => {
      pollTick().catch((err) => console.error("Branch status poll error:", err));
    }, INTERVALS[activity].pollMs);
  }
}

export function getPollerActivity(): ActivityLevel {
  return currentActivity;
}
