import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFile, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

export function tasksDir(): string {
  return join(bandHome(), "tasks");
}

export function cronjobsDir(): string {
  return join(bandHome(), "cronjobs");
}

export function stateFile(): string {
  return join(bandHome(), "state.json");
}

export function settingsFile(): string {
  return join(bandHome(), "settings.json");
}

export function ensureDirs(): void {
  mkdirSync(bandHome(), { recursive: true });
  mkdirSync(statusDir(), { recursive: true });
  mkdirSync(tasksDir(), { recursive: true });
  mkdirSync(cronjobsDir(), { recursive: true });
}

export function loadState(): AppState {
  try {
    const data = readFileSync(stateFile(), "utf-8");
    return JSON.parse(data) as AppState;
  } catch {
    return { projects: [] };
  }
}

export function saveState(state: AppState): void {
  ensureDirs();
  writeFileSync(stateFile(), JSON.stringify(state, null, 2), "utf-8");
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
