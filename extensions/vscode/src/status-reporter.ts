import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { AgentState } from "./agent-monitor";
import { BandConfig } from "./config";

export class StatusReporter {
  private statusDir: string;
  private statusFile: string;
  private config: BandConfig;

  constructor(config: BandConfig) {
    this.config = config;
    this.statusDir = path.join(os.homedir(), ".band", "status");
    this.statusFile = path.join(
      this.statusDir,
      `${config.workspaceId}.json`
    );
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
      pid: process.pid,
      agent: this.config.agent
        ? {
            name: this.config.agent.name,
            status: state.status,
            lastActivity: state.lastActivity.toISOString(),
            summary: state.summary,
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
