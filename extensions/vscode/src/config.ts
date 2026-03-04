import * as fs from "fs";
import * as path from "path";
import * as cp from "child_process";
import { parse } from "yaml";

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
  project: string;
  workspaceId: string; // derived: project-branch
  layout?: LayoutConfig;
  terminals?: TerminalConfig[];
}

export function getConfigPath(workspacePath: string): string {
  return path.join(workspacePath, ".band", "config.yaml");
}

function getGitBranch(workspacePath: string): string | null {
  try {
    const result = cp.execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: workspacePath,
      encoding: "utf-8",
      timeout: 5000,
    });
    return result.trim() || null;
  } catch {
    return null;
  }
}

export async function loadConfig(
  workspacePath: string
): Promise<BandConfig | null> {
  const configPath = getConfigPath(workspacePath);

  try {
    await fs.promises.access(configPath, fs.constants.R_OK);
    const content = await fs.promises.readFile(configPath, "utf-8");
    const config = parse(content) as BandConfig;

    // Derive workspaceId from project name + git branch
    const branch = getGitBranch(workspacePath);
    if (!branch) {
      console.log(`[Band] Could not determine git branch for ${workspacePath}`);
      return null;
    }
    config.workspaceId = `${config.project}-${branch}`;

    return config;
  } catch (err) {
    console.log(`[Band] Failed to load config at ${configPath}:`, err);
    return null;
  }
}
