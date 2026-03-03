import * as vscode from "vscode";
import { AgentPatterns } from "./config";

export type AgentStatusType =
  | "idle"
  | "working"
  | "needs_input"
  | "error"
  | "done";

export interface AgentState {
  status: AgentStatusType;
  lastActivity: Date;
  summary: string;
}

export class AgentMonitor {
  private state: AgentState = {
    status: "idle",
    lastActivity: new Date(),
    summary: "",
  };
  private patterns: Map<AgentStatusType, RegExp> = new Map();
  private disposables: vscode.Disposable[] = [];
  private terminal: vscode.Terminal | undefined;
  private pollInterval: NodeJS.Timeout | undefined;
  private onStateChange: ((state: AgentState) => void) | undefined;

  constructor(
    patterns?: AgentPatterns,
    onStateChange?: (state: AgentState) => void
  ) {
    this.onStateChange = onStateChange;

    // Set up regex patterns
    const defaultPatterns: AgentPatterns = {
      working:
        "\\b(Thinking|Reading|Writing|Searching|Analyzing|Generating)\\b",
      needs_input: "\\b(Y/n|yes/no|approve|deny|permission|\\?\\s*$)\\b",
      error: "\\b(Error|Failed|error:|FATAL|panic)\\b",
      done: "\\b(Done|Completed|finished|Task completed)\\b",
    };

    const merged = { ...defaultPatterns, ...patterns };
    for (const [key, pattern] of Object.entries(merged)) {
      if (pattern) {
        this.patterns.set(key as AgentStatusType, new RegExp(pattern, "i"));
      }
    }
  }

  start(terminal: vscode.Terminal): void {
    this.terminal = terminal;
    // Poll terminal by checking active terminal state
    // Note: vscode.Terminal.onDidWriteData is a proposed API
    // We use polling as a stable fallback
    this.pollInterval = setInterval(() => this.pollTerminal(), 2000);
  }

  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = undefined;
    }
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
  }

  getState(): AgentState {
    return { ...this.state };
  }

  private async pollTerminal(): Promise<void> {
    if (!this.terminal) return;

    // Since there's no stable API to read terminal buffer,
    // we check if the terminal is still active and use
    // heuristics based on terminal state
    // In a production extension, we'd use a PTY wrapper or
    // the proposed onDidWriteData API

    // For now, detect based on terminal process state
    const isActive = this.terminal.exitStatus === undefined;
    if (!isActive) {
      this.updateState("done", "Terminal process ended");
    }
  }

  // Called externally when terminal data is available
  // (via proposed API or PTY wrapper)
  processOutput(data: string): void {
    const lines = data.split("\n").filter((l) => l.trim());
    if (lines.length === 0) return;

    const lastLines = lines.slice(-3).join(" ");

    // Check patterns in priority order
    for (const status of [
      "error",
      "needs_input",
      "done",
      "working",
    ] as AgentStatusType[]) {
      const pattern = this.patterns.get(status);
      if (pattern && pattern.test(lastLines)) {
        const summary =
          lines[lines.length - 1]?.trim().slice(0, 100) || "";
        this.updateState(status, summary);
        return;
      }
    }
  }

  private updateState(status: AgentStatusType, summary: string): void {
    if (this.state.status === status && this.state.summary === summary) return;

    this.state = {
      status,
      lastActivity: new Date(),
      summary,
    };

    this.onStateChange?.(this.state);
  }
}
