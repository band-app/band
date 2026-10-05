import { randomUUID } from "node:crypto";
import type { ScriptPlan, ScriptWorktree } from "@band-app/host-api";
import { createLogger } from "@band-app/logger";
import { hostRegistry } from "../infra/host/registry";
import { terminalService } from "./terminal-service";
import { emit } from "./watcher-service";
// FRAGILE: ESM cycle leg — `./worktree-service` imports
// `worktreeScriptService` from this file. Safe only because every
// `worktreeService` (and `terminalService`, which also imports
// `./worktree-service`) reference below is inside a function body, where
// ESM live binding has filled it in. Capturing either at module load, or
// taking them as constructor parameters of the singleton below, would
// silently get `undefined`.
import { worktreeService } from "./worktree-service";

const log = createLogger("worktree-script-service");

export type WorktreeScript = "setup" | "teardown";

/** How a script run ended. */
export type ScriptOutcome =
  | { kind: "exited"; code: number }
  /** The terminal went away (tab closed, worktree removed) before the script finished. */
  | { kind: "closed" }
  | { kind: "timeout" }
  /** The terminal never started. */
  | { kind: "error"; message: string };

/**
 * Runs a worktree's `setup` and `teardown` commands (from
 * `.band/environment.json`, else `.band/config.json`) in
 * a terminal tab of that worktree, so the user can watch the output, see a
 * failure, and interact with a prompt the script raises.
 *
 * Setup runs alongside the agent's first prompt rather than ahead of it (see
 * `WorktreeService.create`). Teardown runs when a worktree is removed, and
 * `WorktreeService.remove` waits for it before deleting anything.
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
export class WorktreeScriptService {
  /** `${worktreeId}\0${script}` -> the running script. */
  private readonly running = new Map<string, { worktreeId: string; script: WorktreeScript }>();

  /** Worktrees with a script in flight, for the watcher's on-connect snapshot. */
  getRunning(): { worktreeId: string; script: WorktreeScript }[] {
    return Array.from(this.running.values());
  }

  /** The worktree's `setup` or `teardown` command, if it declares one. */
  async getCommand(
    worktreeId: string,
    script: WorktreeScript,
    worktree: ScriptWorktree,
  ): Promise<string | undefined> {
    const host = hostRegistry.hostFor(worktreeId);
    return (await host.scripts.command({ ...worktree, label: script })) ?? undefined;
  }

  /**
   * Start the worktree's `setup` command in a new terminal tab, if it has
   * one, then open the `terminals` its `.band/environment.json` declares (a
   * failed setup leaves them closed). Returns straight away; nothing waits on
   * the result.
   */
  startSetup(worktreeId: string, worktreePath: string, repoPath: string): void {
    void (async () => {
      const worktree = { worktreePath, repoPath };
      if (await this.getCommand(worktreeId, "setup", worktree)) {
        const outcome = await this.run(worktreeId, "setup", worktree);
        if (outcome.kind !== "exited" || outcome.code !== 0) return;
      }
      await this.openDeclaredTerminals(worktreeId, worktree);
    })().catch((err) => log.error({ err, worktreeId }, "could not start the setup script"));
  }

  /** Opens one terminal per entry of the worktree's `.band/environment.json` `terminals`. */
  private async openDeclaredTerminals(worktreeId: string, worktree: ScriptWorktree): Promise<void> {
    const report = await hostRegistry.hostFor(worktreeId).scripts.environment(worktree);
    for (const { name, command } of report.environment?.terminals ?? []) {
      // The worktree may have been removed while setup ran.
      if (!worktreeService.resolve(worktreeId)) return;
      const terminalId = randomUUID();
      try {
        await terminalService.spawn(worktreeId, terminalId, { command });
        emit({ kind: "terminal-created", worktreeId, terminalId });
      } catch (err) {
        log.warn({ err, worktreeId, name }, "could not open a terminal from the environment");
      }
    }
  }

  /**
   * Run the worktree's `script` in a new terminal tab and resolve once it
   * finishes, its terminal goes away, or `timeoutMs` passes. Never rejects.
   * A second call for the same worktree and script while one is running
   * resolves `closed` without starting another.
   */
  async run(
    worktreeId: string,
    script: WorktreeScript,
    worktree: ScriptWorktree,
    timeoutMs?: number,
  ): Promise<ScriptOutcome> {
    const key = `${worktreeId}\0${script}`;
    // No second terminal and no status event for a duplicate: the first run
    // reports for both. `WorktreeService.remove` joins a repeat removal to
    // the first one before it gets here, so this is only a backstop.
    if (this.running.has(key)) return { kind: "closed" };
    this.running.set(key, { worktreeId, script });
    emit({ kind: "setup-status", worktreeId, script, setupState: "running" });

    if (process.platform === "win32") {
      return this.finish(
        worktreeId,
        script,
        key,
        await runHidden(worktreeId, script, worktree, timeoutMs),
      );
    }

    const terminalId = randomUUID();
    let prepared: ScriptPlan | undefined;
    let unsubscribeExit = () => {};
    let timer: NodeJS.Timeout | undefined;
    let outcome: ScriptOutcome;
    try {
      const host = hostRegistry.hostFor(worktreeId);
      const plan = await host.scripts.prepare({ ...worktree, label: script });
      if (!plan) throw new Error(`The worktree has no ${script} script`);
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
      await terminalService.spawn(worktreeId, terminalId, { command: prepared.command });
      emit({ kind: "terminal-created", worktreeId, terminalId });
      const finished = exited.then((code): ScriptOutcome => ({ kind: "exited", code }));
      outcome = await Promise.race([finished, closed, timedOut]);
    } catch (err) {
      outcome = { kind: "error", message: err instanceof Error ? err.message : String(err) };
    } finally {
      unsubscribeExit();
      clearTimeout(timer);
      prepared?.dispose();
    }
    return this.finish(worktreeId, script, key, outcome, terminalId);
  }

  /** Clear the running entry, report the outcome, and pass it through. */
  private finish(
    worktreeId: string,
    script: WorktreeScript,
    key: string,
    outcome: ScriptOutcome,
    terminalId?: string,
  ): ScriptOutcome {
    this.running.delete(key);
    log.info({ worktreeId, script, terminalId, outcome }, "worktree script finished");
    // A removed worktree has no card left to update. A finished teardown
    // reports nothing either: the removal follows at once, and its `remove`
    // event clears the card's status, so it stays marked as deleting until
    // then rather than flashing back to normal. For the same reason a setup
    // that ends while the worktree is tearing down reports nothing: the
    // dashboard keeps one status per worktree, and it would replace the
    // teardown's.
    if (
      script === "setup" &&
      !this.running.has(`${worktreeId}\0teardown`) &&
      worktreeService.resolve(worktreeId)
    ) {
      const error = describeFailure(script, outcome);
      emit(
        error
          ? { kind: "setup-status", worktreeId, script, setupState: "failed", setupError: error }
          : { kind: "setup-status", worktreeId, script, setupState: "completed" },
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
  worktreeId: string,
  script: WorktreeScript,
  paths: ScriptWorktree,
  timeoutMs: number | undefined,
): Promise<ScriptOutcome> {
  const worktree = worktreeService.resolve(worktreeId);
  if (!worktree) return { kind: "error", message: `Worktree not found: ${worktreeId}` };
  try {
    const command = await worktree.host.scripts.command({ ...paths, label: script });
    if (command === null) throw new Error(`The worktree has no ${script} script`);
    const code = await worktree.host.scripts.runHidden(command, worktree.worktree.path, timeoutMs);
    return code === null ? { kind: "timeout" } : { kind: "exited", code };
  } catch (err) {
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

/** A user-facing reason the script failed, or `undefined` if it succeeded. */
function describeFailure(script: WorktreeScript, outcome: ScriptOutcome): string | undefined {
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

export const worktreeScriptService = new WorktreeScriptService();
