import * as fs from "fs";
import * as path from "path";
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

export interface TerminalConfig {
  name: string;
  command: string;
  monitor?: boolean;
}

export interface AgentPatterns {
  working?: string;
  needs_input?: string;
  error?: string;
  done?: string;
}

export interface AgentConfig {
  name: string;
  patterns?: AgentPatterns;
}

export interface BandConfig {
  workspaceId: string;
  project: string;
  layout?: LayoutConfig;
  terminals?: TerminalConfig[];
  agent?: AgentConfig;
}

export function getConfigPath(workspacePath: string): string {
  return path.join(workspacePath, ".band", "config.yaml");
}

export async function loadConfig(
  workspacePath: string
): Promise<BandConfig | null> {
  const configPath = getConfigPath(workspacePath);

  try {
    await fs.promises.access(configPath, fs.constants.R_OK);
    const content = await fs.promises.readFile(configPath, "utf-8");
    const config = parse(content) as BandConfig;
    return config;
  } catch (err) {
    console.log(`[Band] Failed to load config at ${configPath}:`, err);
    return null;
  }
}
