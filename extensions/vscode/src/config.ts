import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface TerminalConfig {
  name: string;
  command: string;
  split?: "horizontal" | "vertical";
}

export interface AppConfig {
  type: string;
  size?: number;
  split?: "horizontal" | "vertical";
  terminals?: TerminalConfig[];
  commands?: { name?: string; command: string; split?: "horizontal" | "vertical" }[];
  url?: string;
}

export interface BandConfig {
  apps?: AppConfig[];
}

export function getConfigPath(workspacePath: string): string {
  return path.join(workspacePath, ".band", "config.json");
}

export async function loadConfig(workspacePath: string): Promise<BandConfig | null> {
  const configPath = getConfigPath(workspacePath);

  try {
    await fs.promises.access(configPath, fs.constants.R_OK);
    const content = await fs.promises.readFile(configPath, "utf-8");
    const config = JSON.parse(content) as BandConfig;

    return config;
  } catch (err) {
    console.log(`[Band] Failed to load config at ${configPath}:`, err);
    return null;
  }
}

export async function loadUserDefaults(): Promise<BandConfig | null> {
  const settingsPath = path.join(os.homedir(), ".band", "settings.json");

  try {
    await fs.promises.access(settingsPath, fs.constants.R_OK);
    const content = await fs.promises.readFile(settingsPath, "utf-8");
    const settings = JSON.parse(content);

    if (settings?.defaults) {
      return settings.defaults as BandConfig;
    }

    return null;
  } catch (err) {
    console.log(`[Band] Failed to load user defaults:`, err);
    return null;
  }
}

export function mergeConfigs(
  defaults: BandConfig | null,
  projectConfig: BandConfig | null,
): BandConfig | null {
  if (!defaults && !projectConfig) {
    return null;
  }
  if (!defaults) {
    return projectConfig;
  }
  if (!projectConfig) {
    return defaults;
  }

  // Project apps fully replace user default apps (not merged per-element)
  return {
    apps: projectConfig.apps ?? defaults.apps,
  };
}

export async function loadEffectiveConfig(
  workspacePath: string,
  projectPath?: string,
): Promise<BandConfig | null> {
  let projectConfig = await loadConfig(workspacePath);
  // Fall back to the main repo path when the worktree has no config
  // (e.g. .band/config.json is .gitignored so new worktrees don't contain it)
  if (!projectConfig && projectPath && projectPath !== workspacePath) {
    projectConfig = await loadConfig(projectPath);
  }
  const defaults = await loadUserDefaults();
  return mergeConfigs(defaults, projectConfig);
}

export interface WorkspaceIdentity {
  project: string;
  branch: string;
  workspaceId: string;
  projectPath: string;
}

export async function getBandWorktreeIdentity(
  workspacePath: string,
): Promise<WorkspaceIdentity | null> {
  const statePath = path.join(os.homedir(), ".band", "state.json");

  try {
    await fs.promises.access(statePath, fs.constants.R_OK);
    const content = await fs.promises.readFile(statePath, "utf-8");
    const state = JSON.parse(content);

    if (state && Array.isArray(state.projects)) {
      for (const project of state.projects) {
        if (Array.isArray(project.worktrees)) {
          for (const wt of project.worktrees) {
            if (wt.path === workspacePath) {
              return {
                project: project.name,
                branch: wt.branch,
                workspaceId: `${project.name}-${wt.branch.replaceAll("/", "-")}`,
                projectPath: project.path,
              };
            }
          }
        }
      }
    }

    return null;
  } catch (err) {
    console.log(`[Band] Failed to read state.json:`, err);
    return null;
  }
}

/**
 * Use git to find the main worktree (project root) for the given workspace.
 * Returns null if the workspace is not inside a git repo or is itself the main worktree.
 */
export async function getGitMainWorktreePath(workspacePath: string): Promise<string | null> {
  try {
    const gitCommonDir = await new Promise<string>((resolve, reject) => {
      execFile(
        "git",
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        { cwd: workspacePath, encoding: "utf-8" },
        (err, stdout) => (err ? reject(err) : resolve(stdout.trim())),
      );
    });

    // git-common-dir returns <main-repo>/.git for both main and worktrees
    const mainRepo = path.dirname(gitCommonDir);
    if (mainRepo === workspacePath) {
      return null; // already the main worktree
    }
    return mainRepo;
  } catch {
    return null;
  }
}

export interface CodingAgentSettings {
  type: string;
  command?: string;
}

interface CodingAgentDefinition {
  id: string;
  type: string;
  label: string;
  command?: string;
}

export async function loadCodingAgentSettings(): Promise<CodingAgentSettings | null> {
  const settingsPath = path.join(os.homedir(), ".band", "settings.json");

  try {
    await fs.promises.access(settingsPath, fs.constants.R_OK);
    const content = await fs.promises.readFile(settingsPath, "utf-8");
    const settings = JSON.parse(content);

    if (settings?.codingAgents && Array.isArray(settings.codingAgents)) {
      const agents = settings.codingAgents as CodingAgentDefinition[];
      const defaultId = settings.defaultCodingAgent as string | undefined;
      const agent = (defaultId ? agents.find((a) => a.id === defaultId) : undefined) ?? agents[0];
      if (agent) {
        return { type: agent.type, command: agent.command };
      }
    }

    return null;
  } catch (err) {
    console.log(`[Band] Failed to load coding agent settings:`, err);
    return null;
  }
}
