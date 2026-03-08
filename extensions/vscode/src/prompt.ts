import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CodingAgentSettings } from "./config";

export interface WorkspacePrompt {
  prompt: string;
  didRun: boolean;
}

export function promptFilePath(workspaceId: string): string {
  return path.join(os.homedir(), ".band", "workspace-prompts", `${workspaceId}.json`);
}

export async function loadPrompt(workspaceId: string): Promise<WorkspacePrompt | null> {
  const filePath = promptFilePath(workspaceId);

  try {
    await fs.promises.access(filePath, fs.constants.R_OK);
    const content = await fs.promises.readFile(filePath, "utf-8");
    return JSON.parse(content) as WorkspacePrompt;
  } catch {
    return null;
  }
}

export async function markPromptAsRun(workspaceId: string): Promise<void> {
  const filePath = promptFilePath(workspaceId);
  const content = await fs.promises.readFile(filePath, "utf-8");
  const data = JSON.parse(content) as WorkspacePrompt;
  data.didRun = true;
  await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2));
}

export async function ensureTrustDialogAccepted(workspacePath: string): Promise<void> {
  const claudeJsonPath = path.join(os.homedir(), ".claude.json");

  let data: Record<string, unknown> = {};
  try {
    const content = await fs.promises.readFile(claudeJsonPath, "utf-8");
    data = JSON.parse(content);
  } catch {
    // File doesn't exist or is invalid — start fresh
  }

  const projects = (data.projects as Record<string, Record<string, unknown>>) ?? {};
  if (projects[workspacePath]?.hasTrustDialogAccepted === true) {
    return;
  }

  projects[workspacePath] = {
    ...projects[workspacePath],
    hasTrustDialogAccepted: true,
  };
  data.projects = projects;

  await fs.promises.writeFile(claudeJsonPath, JSON.stringify(data, null, 2));
}

export function buildAgentCommand(
  agentSettings: CodingAgentSettings,
  prompt: string,
): string | null {
  if (agentSettings.type === "claude-code") {
    const command = agentSettings.command || "claude";
    const escapedPrompt = prompt.replace(/'/g, "'\\''");
    return `echo '${escapedPrompt}' | ${command} --dangerously-skip-permissions`;
  }

  return null;
}
