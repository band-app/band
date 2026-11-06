import type { ServerPlugin } from "@band-app/plugin-api/server";
import githubManifest from "@band-app/plugin-github/band-plugin.json" with { type: "json" };
import githubServer from "@band-app/plugin-github/server";

export interface BundledPlugin {
  /** The raw `band-plugin.json`; `PluginHost` validates it before activating anything. */
  manifest: unknown;
  server: ServerPlugin;
}

/**
 * The plugins that ship with Band. Band loads no third-party code, so this
 * list is the whole plugin set. The client half is in
 * `src/plugins/bundled-client-plugins.ts`.
 */
export const BUNDLED_PLUGINS: BundledPlugin[] = [
  { manifest: githubManifest, server: githubServer },
];
