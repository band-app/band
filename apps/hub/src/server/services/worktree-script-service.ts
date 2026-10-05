import { randomUUID } from "node:crypto";
import type { ScriptPlan, ScriptWorkspace } from "@band-app/host-api";
import { createLogger } from "@band-app/logger";
import { hostRegistry } from "../infra/host/registry";
import { terminalService } from "./terminal-service";
import { emit } from "./watcher-service";
// FRAGILE: ESM cycle leg — `./workspace-service` imports
// `workspaceScriptService` from this file. Safe only because every
// `workspaceService` (and `terminalService`, which also imports
// `./workspace-service`) reference below is inside a function body, where
// ESM live binding has filled it in. Capturing either at module load, or
// taking them as constructor parameters of the singleton below, would
// silently get `undefined`.
import { workspaceService } from "./workspace-service";

const log = createLogger("workspace-script-service");

export type WorkspaceScript = "setup" | "teardown";

/** How a script run ended. */
export type ScriptOutcome =
  | { kind: "exited"; code: number }
  /** The terminal went away (tab closed, workspace removed) before the script finished. */
  | { kind: "closed" }
  | { kind: "timeout" }
  /** The terminal never started. */
  | { kind: "error"; message: string };

/**
 * Runs a workspace's `setup` and `teardown` commands (from
 * `.band/environment.json`, else `.band/config.json`) in
 * a terminal tab of that workspace, so the user can watch the output, see a
 * failure, and interact with a prompt the script raises.
 *
 * Setup runs alongside the agent's first prompt rather than ahead of it (see
 * `WorkspaceService.create`). Teardown runs when a workspace is removed, and
 * `WorkspaceService.remove` waits for it before deleting anything.
 *
 * Progress goes out as `setup-status` events tagged with the script (a
 * teardown only reports `running`; see {@link run}), and a
 * dashboard that connects mid-run gets the running ones from
 * {@link getRunning} via the watcher snapshot. The running set lives in
 * memory, so a server restart forgets it; the terminal itself (and the
 * script in it) keeps running in the terminal daemon.
 *
 * On Windows the commands run hidden through cmd.exe instead (see
 * `runHidden`), since the terminal there cannot run the bash wrapper that
 * reports the exit code.
 */
export class WorkspaceScriptService {
  /** `${workspaceId}\0${script}` -> the running script. */
  private readonly running = new Map<string, { workspaceId: string; script: WorkspaceScript }>();

  /** Workspaces with a script in flight, for the watcher's on-connect snapshot. */
  getRunning(): { workspaceId: string; script: WorkspaceScript }[] {
    return Array.from(this.running.values());
  }

  /** The workspace's `setup` or `teardown` command, if it declares one. */
  async getCommand(
    workspaceId: string,
    script: WorkspaceScript,
    workspace: ScriptWorkspace,
  ): Promise<string | undefined> {
    const host = hostRegistry.hostFor(workspaceId);
    return (await host.scripts.command({ ...workspace, label: script })) ?? undefined;
  }

  /**
   * Start the workspace's `setup` command in a new terminal tab, if it has
   * one, then open the `terminals` its `.band/environment.json` declares (a
   * failed setup leaves them closed). Returns straight away; nothing waits on
   * the result.
   */
  startSetup(workspaceId: string, worktreePath: string, projectPath: string): void {
    void (async () => {
      const workspace = { worktreePath, projectPath };
      if (await this.getCommand(workspaceId, "setup", workspace)) {
        const outcome = await this.run(workspaceId, "setup", workspace);
        if (outcome.kind !== "exited" || outcome.code !== 0) return;
      }
      await this.openDeclaredTerminals(workspaceId, workspace);
    })().catch((err) => log.error({ err, workspaceId }, "could not start the setup script"));
  }

  /** Opens one terminal per entry of the workspace's `.band/environment.json` `terminals`. */
  private async openDeclaredTerminals(
    workspaceId: string,
    workspace: ScriptWorkspace,
  ): Promise<void> {
    const report = await hostRegistry.hostFor(workspaceId).scripts.environment(workspace);
    for (const { name, command } of report.environment?.terminals ?? []) {
      // The workspace may have been removed while setup ran.
      if (!workspaceService.resolve(workspaceId)) return;
      const terminalId = randomUUID();
      try {
        await terminalService.spawn(workspaceId, terminalId, { command });
        emit({ kind: "terminal-created", workspaceId, terminalId });
      } catch (err) {
        log.warn({ err, workspaceId, name }, "could not open a terminal from the environment");
      }
    }
  }

  /**
   * Run the workspace's `script` in a new terminal tab and resolve once it
   * finishes, its terminal goes away, or `timeoutMs` passes. Never rejects.
   * A second call for the same workspace and script while one is running
   * resolves `closed` without starting another.
   */
  async run(
    workspaceId: string,
    script: WorkspaceScript,
    workspace: ScriptWorkspace,
    timeoutMs?: number,
  ): Promise<ScriptOutcome> {
    const key = `${workspaceId}\0${script}`;
    // No second terminal and no status event for a duplicate: the first run
    // reports for both. `WorkspaceService.remove` joins a repeat removal to
    // the first one before it gets here, so this is only a backstop.
    if (this.running.has(key)) return { kind: "closed" };
    this.running.set(key, { workspaceId, script });
    emit({ kind: "setup-status", workspaceId, script, setupState: "running" });

    if (process.platform === "win32") {
      return this.finish(
        workspaceId,
        script,
        key,
        await runHidden(workspaceId, script, workspace, timeoutMs),
      );
    }

    const terminalId = randomUUID();
    let prepared: ScriptPlan | undefined;
    let unsubscribeExit = () => {};
    let timer: NodeJS.Timeout | undefined;
    let outcome: ScriptOutcome;
    try {
      const host = hostRegistry.hostFor(workspaceId);
      const plan = await host.scripts.prepare({ ...workspace, label: script });
      if (!plan) throw new Error(`The workspace has no ${script} script`);
      prepared = plan;
      const { exited } = prepared;
      // Subscribe before the spawn so an exit during it still counts.
      const closed = new Promise<ScriptOutcome>((resolve) => {
        unsubscribeExit = terminalService.onExit(terminalId, () => resolve({ kind: "closed" }));
      });
      const timedOut = new Promise<ScriptOutcome>((resolve) => {
        if (timeoutMs !== undefined) {
          timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
        }
      });
      await terminalService.spawn(workspaceId, terminalId, { command: prepared.command });
      emit({ kind: "terminal-created", workspaceId, terminalId });
      const finished = exited.then((code): ScriptOutcome => ({ kind: "exited", code }));
      outcome = await Promise.race([finished, closed, timedOut]);
    } catch (err) {
      outcome = { kind: "error", message: err instanceof Error ? err.message : String(err) };
    } finally {
      unsubscribeExit();
      clearTimeout(timer);
      prepared?.dispose();
    }
    return this.finish(workspaceId, script, key, outcome, terminalId);
  }

  /** Clear the running entry, report the outcome, and pass it through. */
  private finish(
    workspaceId: string,
    script: WorkspaceScript,
    key: string,
    outcome: ScriptOutcome,
    terminalId?: string,
  ): ScriptOutcome {
    this.running.delete(key);
    log.info({ workspaceId, script, terminalId, outcome }, "workspace script finished");
    // A removed workspace has no card left to update. A finished teardown
    // reports nothing either: the removal follows at once, and its `remove`
    // event clears the card's status, so it stays marked as deleting until
    // then rather than flashing back to normal. For the same reason a setup
    // that ends while the workspace is tearing down reports nothing: the
    // dashboard keeps one status per workspace, and it would replace the
    // teardown's.
    if (
      script === "setup" &&
      !this.running.has(`${workspaceId}\0teardown`) &&
      workspaceService.resolve(workspaceId)
    ) {
      const error = describeFailure(script, outcome);
      emit(
        error
          ? { kind: "setup-status", workspaceId, script, setupState: "failed", setupError: error }
          : { kind: "setup-status", workspaceId, script, setupState: "completed" },
      );
    }
    return outcome;
  }
}

/**
 * Windows: run the command without a terminal. Terminals there use cmd.exe,
 * which cannot run the bash wrapper that reports the exit code.
 */
async function runHidden(
  workspaceId: string,
  script: WorkspaceScript,
  paths: ScriptWorkspace,
  timeoutMs: number | undefined,
): Promise<ScriptOutcome> {
  const workspace = workspaceService.resolve(workspaceId);
  if (!workspace) return { kind: "error", message: `Workspace not found: ${workspaceId}` };
  try {
    const command = await workspace.host.scripts.command({ ...paths, label: script });
    if (command === null) throw new Error(`The workspace has no ${script} script`);
    const code = await workspace.host.scripts.runHidden(
      command,
      workspace.worktree.path,
      timeoutMs,
    );
    return code === null ? { kind: "timeout" } : { kind: "exited", code };
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

/** A user-facing reason the script failed, or `undefined` if it succeeded. */
function describeFailure(script: WorkspaceScript, outcome: ScriptOutcome): string | undefined {
  switch (outcome.kind) {
    case "exited":
      return outcome.code === 0 ? undefined : `${script} exited with code ${outcome.code}`;
    case "closed":
      return `${script} terminal closed before the command finished`;
    case "timeout":
      return `${script} timed out`;
    case "error":
      return `could not start the ${script} terminal: ${outcome.message}`;
  }
}

export const workspaceScriptService = new WorkspaceScriptService();
