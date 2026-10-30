/**
 * The half of a plugin that runs on a worker. The worker loads it from `bundled-worker-plugins.ts`
 * and serves the hub's `plugin.call` link method with it. Calls carry JSON, and a call names the
 * worktree it is for, so a service keeps one set of state per worktree.
 */

import type { PluginLogger } from "./server";

export interface WorkerPluginApi {
  pluginId: string;
  log: PluginLogger;
  /** The worker's private directory. A plugin keeps its files under `<stateDir>/<pluginId>`. */
  stateDir: string;
}

export interface WorkerCall {
  /** The hub's id for the worktree, the key per-worktree state is filed under. */
  worktreeKey: string;
  /** The worktree's folder on this worker, already checked against the worker's roots. */
  worktreePath: string;
}

/**
 * Why a worktree's service is let go.
 *
 * - `removed`: the worktree is gone, so its state is deleted.
 * - `fenced`, `shutdown`: the worker lost the hub's lease or is stopping. Stop what runs and
 *   keep the state, which the worktree uses again later.
 */
export type ReleaseReason = "removed" | "fenced" | "shutdown";

export interface WorkerPluginInstance {
  /** Why this worker cannot run the plugin, or null. Checked once at start, after the manifest's `requires`. */
  unavailable?(): Promise<string | null> | string | null;
  call(method: string, params: unknown, call: WorkerCall): Promise<unknown>;
  release?(worktreeKey: string, reason: ReleaseReason): Promise<void>;
  /** The worker stops. Runs after every `release`. */
  stop?(): Promise<void>;
}

export interface WorkerPlugin {
  id: string;
  create(api: WorkerPluginApi): WorkerPluginInstance;
}

/** The default export of a plugin's worker module. */
export function defineWorkerPlugin(plugin: WorkerPlugin): WorkerPlugin {
  return plugin;
}
