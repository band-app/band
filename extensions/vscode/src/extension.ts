import * as vscode from "vscode";
import { loadConfig } from "./config";
import { setupWorkspace } from "./workspace-setup";
import { AgentMonitor } from "./agent-monitor";
import { StatusReporter } from "./status-reporter";

let monitor: AgentMonitor | undefined;
let reporter: StatusReporter | undefined;

export async function activate(context: vscode.ExtensionContext) {
  console.log("Band extension activating...");

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand("band.setupWorkspace", async () => {
      await runSetup();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("band.showStatus", () => {
      if (monitor) {
        const state = monitor.getState();
        vscode.window.showInformationMessage(
          `Agent: ${state.status} - ${state.summary || "No activity"}`
        );
      } else {
        vscode.window.showInformationMessage("No agent monitor active");
      }
    })
  );

  // Auto-setup if config exists
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders && workspaceFolders.length > 0) {
    const config = await loadConfig(workspaceFolders[0].uri.fsPath);
    if (config) {
      await runSetupWithConfig(config, workspaceFolders[0].uri.fsPath);
    }
  }
}

async function runSetup() {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showErrorMessage("No workspace folder open");
    return;
  }

  // Try each workspace folder
  for (const folder of workspaceFolders) {
    const config = await loadConfig(folder.uri.fsPath);
    if (config) {
      await runSetupWithConfig(config, folder.uri.fsPath);
      return;
    }
  }

  const checkedPath = workspaceFolders[0].uri.fsPath;
  vscode.window.showErrorMessage(
    `No .band/config.yaml found. Checked: ${checkedPath}/.band/config.yaml`
  );
}

async function runSetupWithConfig(config: any, workspacePath: string) {
  // Setup workspace layout and terminals
  const terminals = await setupWorkspace(config);

  // Initialize status reporter
  reporter = new StatusReporter(config);
  await reporter.init();

  // Find the monitored terminal and start agent monitor
  if (config.terminals && config.agent) {
    const monitoredTermConfig = config.terminals.find(
      (t: any) => t.monitor
    );
    if (monitoredTermConfig) {
      const monitoredTerminal = terminals.find(
        (t) => t.name === monitoredTermConfig.name
      );
      if (monitoredTerminal) {
        monitor = new AgentMonitor(config.agent.patterns, async (state) => {
          await reporter?.report(state);
        });
        monitor.start(monitoredTerminal);
      }
    }
  }

  // Write initial idle status
  await reporter.report({
    status: "idle",
    lastActivity: new Date(),
    summary: "Workspace ready",
  });

  vscode.window.showInformationMessage("Band workspace setup complete");
}

export function deactivate() {
  monitor?.stop();
  reporter?.cleanup();
}
