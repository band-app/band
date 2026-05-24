import { eq } from "drizzle-orm";
import { toWorkspaceId } from "@/dashboard";
import { getDb } from "./db/connection";
import { branchStatuses as branchStatusesTable } from "./db/schema";
import { execGh, execGit, getRepoInfo, type RepoInfo } from "./git";
import {
  buildCIQuery,
  type CIStatus,
  type GraphQLRepoResponse,
  parseCIResponse,
} from "./github-graphql";
import { LogThrottle } from "./log-dedupe";
import { loadState } from "./state";
import { syncWorktrees } from "./sync-state";
import { emit } from "./watcher";

/**
 * Throttle for the GraphQL failure log line. Issue #457: the poller used to
 * call `console.error` once per host per CI tick (every 30 s) once an error
 * mode was hit, drowning out the rest of `~/.band/server.log`. We now emit
 * one line per (host, error message) per hour, so the first occurrence of
 * each distinct failure surfaces but a steady-state failure stays quiet.
 */
const ciErrorThrottle = new LogThrottle({ ttlMs: 60 * 60 * 1000 });

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

// Cache repo info per project path within a single CI poll tick.
// Cleared on each CI tick so transferred repos or new remotes are picked up.
const repoInfoCache = new Map<string, RepoInfo>();

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
 * Resolve repo info for a project path, with caching.
 */
async function resolveRepoInfo(projectPath: string): Promise<RepoInfo | null> {
  const cached = repoInfoCache.get(projectPath);
  if (cached !== undefined) return cached;
  const info = await getRepoInfo(projectPath);
  // Only cache successful lookups — null means the remote wasn't available yet
  // (e.g. project added before git remote was configured) and should be retried.
  if (info) {
    repoInfoCache.set(projectPath, info);
  }
  return info;
}

/**
 * Fetch CI status for all workspaces with one GraphQL query per workspace.
 *
 * Each `gh api graphql` invocation issues a plain `repository(...)` selection
 * (no aliased top-level fan-out — see `buildCIQuery` for the rationale and
 * issue #457). Queries run in parallel via `Promise.allSettled`, so for a
 * typical Band user with a handful of workspaces the wall-clock impact is
 * dominated by the slowest single GitHub round-trip rather than by the
 * spawn fan-out.
 *
 * The repeating `GraphQL query failed` line that motivated #457 is gated by
 * `ciErrorThrottle`, so a steady-state failure surfaces once per
 * (host, error message) per hour instead of once per tick.
 */
async function getCIStatuses(workspaces: WorkspaceInfo[]): Promise<Map<string, CIStatus>> {
  // Clear cache so transferred repos or newly configured remotes are picked up
  repoInfoCache.clear();

  const allResults = new Map<string, CIStatus>();

  // Resolve repo info + issue the GraphQL query per workspace, in parallel.
  await Promise.allSettled(
    workspaces.map(async (ws) => {
      const repoInfo = await resolveRepoInfo(ws.projectPath);
      if (!repoInfo) {
        // `getRepoInfo` already logs to console.error on parse/git failure;
        // surface a deduped note here too so callers can see which
        // workspace was skipped without spamming the log every tick.
        const key = `repo-info:${ws.projectPath}`;
        if (ciErrorThrottle.shouldLog(key)) {
          console.error(
            `CI poll: failed to resolve repo info for ${ws.workspaceId} (${ws.projectPath})`,
          );
        }
        return;
      }

      const status = await fetchCIStatusForWorkspace(ws, repoInfo);
      if (status) {
        allResults.set(ws.workspaceId, status);
      }
    }),
  );

  // Fill in "none" for workspaces that didn't produce a status (failed
  // resolve or query). Without this the DB upsert further down would skip
  // those rows entirely and stale CI state would linger.
  for (const ws of workspaces) {
    if (!allResults.has(ws.workspaceId)) {
      allResults.set(ws.workspaceId, { state: "none" });
    }
  }

  return allResults;
}

/**
 * Issue one `gh api graphql` query for a single workspace and parse the
 * response. Returns `null` on failure (already logged via the throttle).
 */
async function fetchCIStatusForWorkspace(
  ws: WorkspaceInfo,
  repoInfo: RepoInfo,
): Promise<CIStatus | null> {
  const query = buildCIQuery({ branch: ws.branch, repoInfo });

  const ghArgs = ["api", "graphql", "-f", `query=${query}`];
  if (repoInfo.host !== "github.com") {
    ghArgs.push("--hostname", repoInfo.host);
  }

  try {
    const output = await execGh(ghArgs, ws.worktreePath);
    const response = JSON.parse(output) as {
      data?: { repository?: GraphQLRepoResponse | null };
    };
    const repo = response.data?.repository ?? null;
    const isDefaultBranch = ws.branch === ws.defaultBranch;
    return parseCIResponse(repo, isDefaultBranch);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Compose a stable key so a recurring failure mode gets one log per TTL
    // rather than one per tick. Trim trailing whitespace to keep tiny
    // differences in `gh` stderr from defeating the throttle.
    const key = `gql:${repoInfo.host}:${message.trim()}`;
    if (ciErrorThrottle.shouldLog(key)) {
      console.error(
        `CI poll: GraphQL query failed for host ${repoInfo.host} (workspace ${ws.workspaceId}): ${message}`,
      );
    }
    return null;
  }
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

  // Fetch CI statuses on CI ticks (one GraphQL request per workspace,
  // in parallel — see `getCIStatuses` for the per-workspace rationale).
  let ciStatuses = new Map<string, CIStatus>();
  if (isCITick) {
    ciStatuses = await getCIStatuses(workspaces);
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
