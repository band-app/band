import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface BrowserConfig {
  url: string;
  pinned?: boolean;
}

export interface LayoutGroup {
  size: number;
  browser?: BrowserConfig;
}

export interface LayoutConfig {
  orientation: "horizontal" | "vertical";
  groups: LayoutGroup[];
}

export type AgentType = "claude-code";

export interface TerminalConfig {
  name: string;
  command: string;
  split?: "horizontal" | "vertical";
  agentType?: AgentType;
}

export interface BandConfig {
  layout?: LayoutConfig;
  terminals?: TerminalConfig[];
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

  return {
    ...defaults,
    ...projectConfig,
  };
}

export async function loadEffectiveConfig(workspacePath: string): Promise<BandConfig | null> {
  const projectConfig = await loadConfig(workspacePath);
  const defaults = await loadUserDefaults();
  return mergeConfigs(defaults, projectConfig);
}

export async function isBandWorktree(workspacePath: string): Promise<boolean> {
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
              return true;
            }
          }
        }
      }
    }

    return false;
  } catch (err) {
    console.log(`[Band] Failed to read state.json:`, err);
    return false;
  }
}
