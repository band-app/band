import * as vscode from "vscode";
import { loadConfig } from "./config";
import { setupWorkspace } from "./workspace-setup";
import { AgentMonitor } from "./agent-monitor";
import { StatusReporter } from "./status-reporter";

let monitor: AgentMonitor | undefined;
let reporter: StatusReporter | undefined;
let log: vscode.OutputChannel;

export async function activate(context: vscode.ExtensionContext) {
  log = vscode.window.createOutputChannel("Band");
  log.appendLine("Band extension activating...");

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

  // Register focus tracking early — before any async work
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState(async (e) => {
      log.appendLine(`[focus] Window state changed: focused=${e.focused}, reporter=${!!reporter}, workspaceId=${reporter?.getWorkspaceId()}`);
      if (e.focused && reporter) {
        try {
          await reporter.reportFocused();
          // When user focuses the window, clear needs_attention/working → waiting
          if (monitor) {
            const state = monitor.getState();
            if (state.status === "needs_attention") {
              await reporter.report({ status: "waiting", lastActivity: new Date() });
            }
          }
          log.appendLine(`[focus] reportFocused() succeeded for ${reporter.getWorkspaceId()}`);
        } catch (err) {
          log.appendLine(`[focus] reportFocused() failed: ${err}`);
        }
      }
    })
  );

  log.appendLine(`[focus] Initial window focused: ${vscode.window.state.focused}`);

  // Auto-setup if config exists
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (workspaceFolders && workspaceFolders.length > 0) {
    const config = await loadConfig(workspaceFolders[0].uri.fsPath);
    if (config) {
      log.appendLine(`Config loaded for workspace: ${config.workspaceId}`);
      await runSetupWithConfig(config, workspaceFolders[0].uri.fsPath);

      // Mark as active on initial setup if window is focused
      if (vscode.window.state.focused && reporter) {
        await reporter.reportFocused();
        log.appendLine("[focus] Wrote initial active state");
      }
    } else {
      log.appendLine("No config found");
    }
  } else {
    log.appendLine("No workspace folders");
  }
}

async function runSetup() {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showErrorMessage("No workspace folder open");
    return;
  }

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
  const result = await setupWorkspace(config);
  monitor = result.monitor;

  const agentTermConfig = config.terminals?.find(
    (t: any) => t.agentType
  );

  reporter = new StatusReporter(config, agentTermConfig?.agentType);
  await reporter.init();
  log.appendLine(`Reporter initialized for: ${config.workspaceId}`);

  if (monitor) {
    monitor.setOnStateChange(async (state) => {
      await reporter?.report(state);
    });
  }

  await reporter.report({
    status: "waiting",
    lastActivity: new Date(),
  });

  vscode.window.showInformationMessage("Band workspace setup complete");
}

export function deactivate() {
  reporter?.cleanup();
}
