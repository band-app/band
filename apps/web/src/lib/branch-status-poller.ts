import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execGh, execGit } from "./git";
import { bandHome, loadState } from "./state";
import { syncWorktrees } from "./sync-state";

interface GitStatus {
  dirty: boolean;
  conflict: boolean;
  ahead: number;
  behind: number;
  sync_state: string;
}

interface CIStatus {
  state: string;
  url?: string | null;
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

function branchStatusDir(): string {
  return join(bandHome(), "branch-status");
}

function getWorkspaces(): WorkspaceInfo[] {
  const state = loadState();
  const workspaces: WorkspaceInfo[] = [];
  for (const project of state.projects) {
    for (const wt of project.worktrees) {
      workspaces.push({
        workspaceId: `${project.name}-${wt.branch}`,
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

async function getCIStatus(worktreePath: string, branch: string): Promise<CIStatus> {
  // Check PR status
  let prUrl: string | null = null;
  try {
    const prOutput = await execGh(["pr", "view", branch, "--json", "state,url"], worktreePath);
    const pr = JSON.parse(prOutput) as { state: string; url: string };
    if (pr.state === "MERGED") {
      return { state: "merged", url: pr.url };
    }
    prUrl = pr.url;
  } catch {
    // No PR or gh not available
  }

  // Check workflow runs
  try {
    const runsOutput = await execGh(
      [
        "run",
        "list",
        "--branch",
        branch,
        "--limit",
        "20",
        "--json",
        "status,conclusion,url,updatedAt,workflowName",
      ],
      worktreePath,
    );
    const runs = JSON.parse(runsOutput) as Array<{
      status: string;
      conclusion: string | null;
      url: string;
      updatedAt: string;
      workflowName: string;
    }>;

    if (runs.length === 0) {
      return { state: "none" };
    }

    // Deduplicate: keep only the latest run per workflow
    const latestByWorkflow = new Map<
      string,
      { status: string; conclusion: string | null; url: string; updatedAt: string }
    >();
    for (const run of runs) {
      const existing = latestByWorkflow.get(run.workflowName);
      if (!existing || run.updatedAt > existing.updatedAt) {
        latestByWorkflow.set(run.workflowName, run);
      }
    }

    // Aggregate status with priority: failure > running > pending > cancelled > success
    let aggregatedState = "success";
    let aggregatedUrl: string | null = null;

    for (const run of latestByWorkflow.values()) {
      let runState: string;
      if (run.status === "in_progress" || run.status === "queued") {
        runState = run.status === "queued" ? "pending" : "running";
      } else if (run.conclusion === "failure") {
        runState = "failure";
      } else if (run.conclusion === "cancelled") {
        runState = "cancelled";
      } else {
        runState = "success";
      }

      const priority = statePriority(runState);
      if (priority > statePriority(aggregatedState)) {
        aggregatedState = runState;
        aggregatedUrl = run.url;
      }
    }

    return { state: aggregatedState, url: prUrl ?? aggregatedUrl };
  } catch {
    return { state: "none" };
  }
}

function statePriority(state: string): number {
  switch (state) {
    case "failure":
      return 4;
    case "running":
      return 3;
    case "pending":
      return 2;
    case "cancelled":
      return 1;
    case "success":
      return 0;
    default:
      return -1;
  }
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
    const uniqueProjectPaths = [...new Set(workspaces.map((w) => w.projectPath))];
    await Promise.allSettled(
      uniqueProjectPaths.map((projectPath) =>
        execGit(["fetch", "--quiet", "--all"], projectPath).catch(() => {}),
      ),
    );
  }

  const dir = branchStatusDir();
  mkdirSync(dir, { recursive: true });

  await Promise.allSettled(
    workspaces.map(async (ws) => {
      const git = await getGitStatus(ws.worktreePath);

      let ci: CIStatus = { state: "none" };
      if (isCITick) {
        ci = await getCIStatus(ws.worktreePath, ws.branch);
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
