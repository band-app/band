import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFile, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getDb } from "./db/connection";
import { projects as projectsTable, worktrees as worktreesTable } from "./db/schema";

export interface ProjectState {
  name: string;
  path: string;
  defaultBranch: string;
  worktrees: WorktreeState[];
  label?: string;
}

export interface WorktreeState {
  branch: string;
  path: string;
  head?: string;
}

export interface AppState {
  projects: ProjectState[];
}

export interface AgentInfo {
  name: string;
  status: string;
  lastActivity: string;
  summary?: string;
}

export interface WorkspaceStatus {
  workspaceId: string;
  project: string;
  branch: string;
  worktreePath: string;
  ide: string;
  agent?: AgentInfo;
}

export interface LabelDefinition {
  id: string;
  name: string;
  color: string;
}

export interface Settings {
  worktreesDir?: string;
  defaults?: unknown;
  codingAgent?: {
    type: string;
    command?: string;
  };
  labels?: LabelDefinition[];
  tokenSecret?: string;
}

export function bandHome(): string {
  if (process.env.BAND_HOME) return process.env.BAND_HOME;
  return join(homedir(), ".band");
}

export function statusDir(): string {
  return join(bandHome(), "status");
}

export function settingsFile(): string {
  return join(bandHome(), "settings.json");
}

export function ensureDirs(): void {
  mkdirSync(bandHome(), { recursive: true });
  mkdirSync(statusDir(), { recursive: true });
}

export function loadState(): AppState {
  const db = getDb();
  const projectRows = db.select().from(projectsTable).orderBy(projectsTable.sortOrder).all();

  const worktreeRows = db.select().from(worktreesTable).all();

  const wtByProject = new Map<string, WorktreeState[]>();
  for (const row of worktreeRows) {
    const list = wtByProject.get(row.projectName) ?? [];
    list.push({
      branch: row.branch,
      path: row.path,
      head: row.head ?? undefined,
    });
    wtByProject.set(row.projectName, list);
  }

  return {
    projects: projectRows.map((row) => ({
      name: row.name,
      path: row.path,
      defaultBranch: row.defaultBranch,
      label: row.label ?? undefined,
      worktrees: wtByProject.get(row.name) ?? [],
    })),
  };
}

export function saveState(state: AppState): void {
  const db = getDb();

  db.transaction((tx) => {
    tx.delete(worktreesTable).run();
    tx.delete(projectsTable).run();

    for (let i = 0; i < state.projects.length; i++) {
      const project = state.projects[i];
      tx.insert(projectsTable)
        .values({
          name: project.name,
          path: project.path,
          defaultBranch: project.defaultBranch,
          label: project.label ?? null,
          sortOrder: i,
        })
        .run();

      for (const wt of project.worktrees) {
        tx.insert(worktreesTable)
          .values({
            projectName: project.name,
            branch: wt.branch,
            path: wt.path,
            head: wt.head ?? null,
          })
          .run();
      }
    }
  });
}

export function loadSettings(): Settings {
  try {
    const data = readFileSync(settingsFile(), "utf-8");
    return JSON.parse(data) as Settings;
  } catch {
    return {};
  }
}

export function getOrCreateToken(): string {
  const settings = loadSettings();
  if (settings.tokenSecret) return settings.tokenSecret;
  const token = randomBytes(32).toString("hex");
  ensureDirs();
  const current = loadSettings();
  current.tokenSecret = token;
  writeFileSync(settingsFile(), JSON.stringify(current, null, 2), "utf-8");
  return token;
}

export function worktreesDir(): string {
  const settings = loadSettings();
  return settings.worktreesDir ?? join(bandHome(), "worktrees");
}

export function loadCurrentStatuses(): WorkspaceStatus[] {
  const dir = statusDir();
  const statuses: WorkspaceStatus[] = [];
  try {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json") || file === "active.json") continue;
      try {
        const data = readFileSync(join(dir, file), "utf-8");
        statuses.push(JSON.parse(data) as WorkspaceStatus);
      } catch {
        // Skip invalid files
      }
    }
  } catch {
    // Status dir may not exist
  }
  return statuses;
}

export function loadStatusFile(filePath: string): Promise<WorkspaceStatus | null> {
  return new Promise((resolve) => {
    readFile(filePath, "utf-8", (err, data) => {
      if (err) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(data) as WorkspaceStatus);
      } catch {
        resolve(null);
      }
    });
  });
}
