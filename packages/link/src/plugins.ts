/**
 * The message that reaches a plugin's worker half (`apps/worker/src/plugins.ts`). The hub sends
 * it for a plugin tool or service call. Params and result are JSON.
 */

/** Hub to worker: `PluginCallParams` in, the plugin's JSON result out. */
export const METHOD_PLUGIN_CALL = "plugin.call";

export interface PluginCallParams {
  pluginId: string;
  method: string;
  params: unknown;
  /** The worktree the call is for. The worker files the plugin's state under `worktreeKey`. */
  worktreeKey: string;
  worktreePath: string;
}
