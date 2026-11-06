import type { WorkerPlugin } from "@band-app/plugin-api/worker";

export interface BundledWorkerPlugin {
  /** The raw `band-plugin.json`, validated before the plugin runs. */
  manifest: unknown;
  worker: WorkerPlugin;
}

/**
 * The plugins whose worker half ships with the worker. Band loads no third-party code, so this
 * list is the whole set. The hub half is in `apps/hub/src/server/services/bundled-plugins.ts`.
 */
export const BUNDLED_WORKER_PLUGINS: BundledWorkerPlugin[] = [];
