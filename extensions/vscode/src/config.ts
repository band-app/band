import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type AgentType = "claude-code";

export interface TerminalConfig {
  name: string;
  command: string;
  split?: "horizontal" | "vertical";
  agentType?: AgentType;
}

export interface VsCodeAppConfig {
  type: "vscode";
  size?: number;
  terminals?: TerminalConfig[];
}

export interface ZedAppConfig {
  type: "zed";
  size?: number;
}

export interface ITermAppConfig {
  type: "iterm";
  size?: number;
  commands?: { name?: string; command: string; split?: "horizontal" | "vertical" }[];
}

export interface ChromeAppConfig {
  type: "chrome";
  size?: number;
  url?: string;
}

export type AppConfig = VsCodeAppConfig | ZedAppConfig | ITermAppConfig | ChromeAppConfig;

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

export async function loadEffectiveConfig(workspacePath: string): Promise<BandConfig | null> {
  const projectConfig = await loadConfig(workspacePath);
  const defaults = await loadUserDefaults();
  return mergeConfigs(defaults, projectConfig);
}

export interface WorkspaceIdentity {
  project: string;
  branch: string;
  workspaceId: string;
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
                workspaceId: `${project.name}-${wt.branch}`,
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

export interface CodingAgentSettings {
  type: string;
  command?: string;
}

export async function loadCodingAgentSettings(): Promise<CodingAgentSettings | null> {
  const settingsPath = path.join(os.homedir(), ".band", "settings.json");

  try {
    await fs.promises.access(settingsPath, fs.constants.R_OK);
    const content = await fs.promises.readFile(settingsPath, "utf-8");
    const settings = JSON.parse(content);

    if (settings?.codingAgent) {
      return settings.codingAgent as CodingAgentSettings;
    }

    return null;
  } catch (err) {
    console.log(`[Band] Failed to load coding agent settings:`, err);
    return null;
  }
}
