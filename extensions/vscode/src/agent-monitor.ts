import { AgentType } from "./config";

export type AgentStatusType = "working" | "needs_attention" | "waiting";

export interface AgentState {
  status: AgentStatusType;
  lastActivity: Date;
}

interface AgentPatterns {
  working: string;
  done: string;
}

const AGENT_PATTERNS: Record<AgentType, AgentPatterns> = {
  "claude-code": {
    working:
      "\\b(Thinking|Reading|Writing|Searching|Analyzing|Generating)\\b",
    done: "\\b(Done|Completed|finished|Task completed|Y/n|yes/no|approve|deny|permission|Error|Failed|error:|FATAL|panic)\\b",
  },
};

export class AgentMonitor {
  private state: AgentState = {
    status: "waiting",
    lastActivity: new Date(),
  };
  private workingPattern: RegExp | undefined;
  private donePattern: RegExp | undefined;
  private onStateChange: ((state: AgentState) => void) | undefined;

  constructor(
    agentType: AgentType,
    onStateChange?: (state: AgentState) => void
  ) {
    this.onStateChange = onStateChange;

    const agentPatterns = AGENT_PATTERNS[agentType];
    this.workingPattern = new RegExp(agentPatterns.working, "i");
    this.donePattern = new RegExp(agentPatterns.done, "i");
  }

  setOnStateChange(callback: (state: AgentState) => void): void {
    this.onStateChange = callback;
  }

  getState(): AgentState {
    return { ...this.state };
  }

  processOutput(data: string): void {
    // Strip ANSI escape sequences for pattern matching
    const clean = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
    const lines = clean.split("\n").filter((l) => l.trim());
    if (lines.length === 0) return;

    const lastLines = lines.slice(-3).join(" ");

    // Check done first (higher priority), then working
    if (this.donePattern && this.donePattern.test(lastLines)) {
      this.updateState("needs_attention");
      return;
    }

    if (this.workingPattern && this.workingPattern.test(lastLines)) {
      this.updateState("working");
      return;
    }
  }

  processExit(): void {
    this.updateState("needs_attention");
  }

  private updateState(status: AgentStatusType): void {
    if (this.state.status === status) return;

    this.state = {
      status,
      lastActivity: new Date(),
    };

    this.onStateChange?.(this.state);
  }
}
