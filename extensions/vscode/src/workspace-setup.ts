import * as vscode from "vscode";
import { BandConfig, LayoutConfig, TerminalConfig, BrowserConfig } from "./config";
import { AgentMonitor } from "./agent-monitor";

export interface SetupResult {
  terminals: vscode.Terminal[];
  monitor?: AgentMonitor;
}

export async function setupWorkspace(
  config: BandConfig
): Promise<SetupResult> {
  const terminals: vscode.Terminal[] = [];
  let monitor: AgentMonitor | undefined;
  let agentTerminal: vscode.Terminal | undefined;

  // Set editor layout if config has layout
  if (config.layout) {
    await setupEditorLayout(config.layout);
  }

  // Create terminals (skip if they already exist from a previous session)
  if (config.terminals) {
    const existingTerminals = vscode.window.terminals;

    for (const termConfig of config.terminals) {
      const existing = existingTerminals.find((t) => t.name === termConfig.name);
      if (existing) {
        terminals.push(existing);
        if (termConfig.agentType) {
          monitor = new AgentMonitor(termConfig.agentType);
          agentTerminal = existing;
        }
        continue;
      }

      const previousTerminal = terminals.length > 0 ? terminals[terminals.length - 1] : undefined;
      const options: vscode.TerminalOptions = {
        name: termConfig.name,
      };
      if (termConfig.split && previousTerminal) {
        options.location = { parentTerminal: previousTerminal };
      }
      const terminal = vscode.window.createTerminal(options);
      if (termConfig.command) {
        terminal.sendText(termConfig.command);
      }
      terminal.show(false);
      terminals.push(terminal);

      if (termConfig.agentType) {
        monitor = new AgentMonitor(termConfig.agentType);
        agentTerminal = terminal;
      }
    }
  }

  // Use shell integration to monitor agent terminal output when available
  if (monitor && agentTerminal) {
    setupTerminalMonitoring(agentTerminal, monitor);
  }

  return { terminals, monitor };
}

function setupTerminalMonitoring(
  terminal: vscode.Terminal,
  monitor: AgentMonitor
): void {
  // Listen for shell execution events on the agent terminal
  const startDisposable = vscode.window.onDidStartTerminalShellExecution(
    async (e) => {
      if (e.terminal !== terminal) return;
      // Read output stream from the execution
      for await (const data of e.execution.read()) {
        monitor.processOutput(data);
      }
    }
  );

  // Detect when the terminal closes
  const closeDisposable = vscode.window.onDidCloseTerminal((t) => {
    if (t === terminal) {
      monitor.processExit();
      startDisposable.dispose();
      closeDisposable.dispose();
    }
  });
}

async function setupEditorLayout(layout: LayoutConfig) {
  const groups = layout.groups.map((g) => ({ size: g.size }));

  if (layout.orientation === "horizontal") {
    await vscode.commands.executeCommand("vscode.setEditorLayout", {
      orientation: 0,
      groups,
    });
  } else {
    await vscode.commands.executeCommand("vscode.setEditorLayout", {
      orientation: 1,
      groups,
    });
  }

  for (let i = 0; i < layout.groups.length; i++) {
    const group = layout.groups[i];
    if (group.browser) {
      await openBrowser(group.browser.url, i + 1, group.browser.pinned);
    }
  }
}

async function openBrowser(
  url: string,
  viewColumn: number,
  pinned?: boolean
) {
  await vscode.commands.executeCommand(
    "simpleBrowser.api.open",
    vscode.Uri.parse(url),
    { viewColumn: viewColumn }
  );
  if (pinned) {
    await vscode.commands.executeCommand("workbench.action.pinEditor");
  }
}
