import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { toWorkspaceId } from "@band/dashboard-core";
import { execGh, execGit, getRepoInfo, type RepoInfo } from "./git";
import {
  buildBatchedCIQuery,
  parseBatchedCIResponse,
  type CIStatus,
} from "./github-graphql";
import { bandHome, loadState } from "./state";
import { syncWorktrees } from "./sync-state";

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
  worktreePath: string;
  projectPath: string;
}

const POLL_INTERVAL_MS = 5000;
const CI_POLL_TICKS = 6; // every 6th tick = 30s

let pollerTimer: ReturnType<typeof setInterval> | null = null;
let tickCount = 0;

// Cache repo info per project path (doesn't change during runtime)
const repoInfoCache = new Map<string, RepoInfo | null>();

function branchStatusDir(): string {
  return join(bandHome(), "branch-status");
}

function getWorkspaces(): WorkspaceInfo[] {
  const state = loadState();
  const workspaces: WorkspaceInfo[] = [];
  for (const project of state.projects) {
    for (const wt of project.worktrees) {
      workspaces.push({
        workspaceId: toWorkspaceId(project.name, wt.branch),
        project: project.name,
        branch: wt.branch,
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
async function resolveRepoInfo(
  projectPath: string,
): Promise<RepoInfo | null> {
  const cached = repoInfoCache.get(projectPath);
  if (cached !== undefined) return cached;
  const info = await getRepoInfo(projectPath);
  repoInfoCache.set(projectPath, info);
  return info;
}

/**
 * Fetch CI status for all workspaces using batched GraphQL queries.
 *
 * Groups workspaces by GitHub host and executes one GraphQL query per host,
 * fetching PR status and check suite results for all branches in a single request.
 * Falls back to individual gh CLI calls if the GraphQL query fails.
 */
async function getBatchedCIStatuses(
  workspaces: WorkspaceInfo[],
): Promise<Map<string, CIStatus>> {
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
  for (const [, group] of byHost) {
    const inputs = group.map((g) => ({
      alias: g.alias,
      branch: g.ws.branch,
      repoInfo: g.repoInfo,
    }));

    const query = buildBatchedCIQuery(inputs);
    // Use any workspace's worktreePath for cwd (gh auth is per-host)
    const cwd = group[0].ws.worktreePath;

    try {
      const output = await execGh(
        ["api", "graphql", "-f", `query=${query}`],
        cwd,
      );
      const response = JSON.parse(output) as {
        data: Record<string, unknown>;
      };
      const parsed = parseBatchedCIResponse(
        response.data as Record<string, never>,
        inputs.map((i) => i.alias),
      );

      // Map aliases back to workspace IDs
      for (const g of group) {
        const status = parsed.get(g.alias);
        if (status) {
          allResults.set(g.ws.workspaceId, status);
        }
      }
    } catch {
      // GraphQL failed for this host — leave workspaces as "none"
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
    await syncWorktrees().catch((err) =>
      console.error("syncWorktrees error:", err),
    );
  }

  const workspaces = getWorkspaces();

  if (workspaces.length === 0) return;

  // On CI ticks, do git fetch in parallel per unique project path
  if (isCITick) {
    const uniqueProjectPaths = [
      ...new Set(workspaces.map((w) => w.projectPath)),
    ];
    await Promise.allSettled(
      uniqueProjectPaths.map((projectPath) =>
        execGit(["fetch", "--quiet", "--all"], projectPath).catch(() => {}),
      ),
    );
  }

  const dir = branchStatusDir();
  mkdirSync(dir, { recursive: true });

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
        // Preserve existing CI status from file on non-CI ticks
        const filePath = join(dir, `${ws.workspaceId}.json`);
        try {
          const existing = JSON.parse(readFileSync(filePath, "utf-8")) as {
            ci?: CIStatus;
          };
          if (existing.ci) ci = existing.ci;
        } catch {
          // File may not exist yet
        }
      }

      const data = {
        workspaceId: ws.workspaceId,
        git,
        ci,
      };

      const filePath = join(dir, `${ws.workspaceId}.json`);
      writeFileSync(filePath, JSON.stringify(data), "utf-8");
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
