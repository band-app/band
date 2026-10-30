import type { WorkerPlugin } from "@band-app/plugin-api/worker";
import simulatorManifest from "@band-app/plugin-simulator/band-plugin.json" with { type: "json" };
import simulatorWorker from "@band-app/plugin-simulator/worker";

export interface BundledWorkerPlugin {
  /** The raw `band-plugin.json`, validated before the plugin runs. */
  manifest: unknown;
  worker: WorkerPlugin;
}

/**
 * The plugins whose worker half ships with the worker. Band loads no third-party code, so this
 * list is the whole set. The hub half is in `apps/hub/src/server/services/bundled-plugins.ts`.
 */
export const BUNDLED_WORKER_PLUGINS: BundledWorkerPlugin[] = [
  { manifest: simulatorManifest, worker: simulatorWorker },
];
