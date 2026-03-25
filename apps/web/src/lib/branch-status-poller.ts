import { toWorkspaceId } from "@band-app/dashboard-core";
import { eq } from "drizzle-orm";
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
}

const POLL_INTERVAL_MS = 5000;
const CI_POLL_TICKS = 6; // every 6th tick = 30s

let pollerTimer: ReturnType<typeof setInterval> | null = null;
let tickCount = 0;

// Cache repo info per project path within a single CI poll tick.
// Cleared on each CI tick so transferred repos or new remotes are picked up.
const repoInfoCache = new Map<string, RepoInfo>();

function getWorkspaces(): WorkspaceInfo[] {
  const state = loadState();
  const workspaces: WorkspaceInfo[] = [];
  for (const project of state.projects) {
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
 * Fetch CI status for all workspaces using batched GraphQL queries.
 *
 * Groups workspaces by GitHub host and executes one GraphQL query per host,
 * fetching PR status and check suite results for all branches in a single request.
 * Falls back to individual gh CLI calls if the GraphQL query fails.
 */
async function getBatchedCIStatuses(workspaces: WorkspaceInfo[]): Promise<Map<string, CIStatus>> {
  // Clear cache so transferred repos or newly configured remotes are picked up
  repoInfoCache.clear();

  // Resolve repo info for all workspaces in parallel
  const resolved: Array<{
    ws: WorkspaceInfo;
    repoInfo: RepoInfo;
    alias: string;
  }> = [];
  await Promise.allSettled(
    workspaces.map(async (ws, index) => {
      const repoInfo = await resolveRepoInfo(ws.projectPath);
      if (repoInfo) {
        resolved.push({ ws, repoInfo, alias: `ws_${index}` });
      } else {
        console.error(
          `CI poll: failed to resolve repo info for ${ws.workspaceId} (${ws.projectPath})`,
        );
      }
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
  const isCITick = tickCount % CI_POLL_TICKS === 0;

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

  // Fetch CI statuses in batch on CI ticks
  let ciStatuses = new Map<string, CIStatus>();
  if (isCITick) {
    ciStatuses = await getBatchedCIStatuses(workspaces);
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
  }, POLL_INTERVAL_MS);
}

export function stopBranchStatusPoller() {
  if (pollerTimer) {
    clearInterval(pollerTimer);
    pollerTimer = null;
  }
}
