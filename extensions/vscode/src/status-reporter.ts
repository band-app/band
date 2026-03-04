import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { AgentState } from "./agent-monitor";
import { AgentType, BandConfig } from "./config";

export class StatusReporter {
  private statusDir: string;
  private statusFile: string;
  private config: BandConfig;
  private agentType?: AgentType;

  constructor(config: BandConfig, agentType?: AgentType) {
    this.config = config;
    this.agentType = agentType;
    this.statusDir = path.join(os.homedir(), ".band", "status");
    this.statusFile = path.join(
      this.statusDir,
      `${config.workspaceId}.json`
    );
  }

  getWorkspaceId(): string {
    return this.config.workspaceId;
  }

  async init(): Promise<void> {
    await fs.promises.mkdir(this.statusDir, { recursive: true });
  }

  async report(state: AgentState, branch?: string): Promise<void> {
    const status = {
      workspaceId: this.config.workspaceId,
      project: this.config.project,
      branch: branch || "",
      worktreePath: "",
      ide: "vscode",
      agent: this.agentType
        ? {
            name: this.agentType,
            status: state.status,
            lastActivity: state.lastActivity.toISOString(),
          }
        : undefined,
    };

    await fs.promises.writeFile(
      this.statusFile,
      JSON.stringify(status, null, 2)
    );
  }

  async cleanup(): Promise<void> {
    try {
      await fs.promises.unlink(this.statusFile);
    } catch {
      // File may not exist
    }
  }
}
