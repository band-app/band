import { z } from "zod";

/** The plugin API version this build of Band implements. */
export const PLUGIN_API_VERSION = 1;

/**
 * Events that activate a plugin's server module.
 *
 * - `onStartup` activates the plugin when the server boots.
 * - `onRepoRemote:<host glob>` activates it the first time the core needs a
 *   provider for a repository whose `origin` host matches the glob. `*`
 *   matches any run of characters, so `*.ghe.com` matches `acme.ghe.com`.
 */
const activationEventSchema = z.union([
  z.literal("onStartup"),
  z.string().regex(/^onRepoRemote:[a-z0-9.*-]+$/),
]);

/** Client slot ids a plugin may fill. The core renders each one. */
export const CLIENT_SLOT_IDS = ["worktree.sideTabs"] as const;
export type ClientSlotId = (typeof CLIENT_SLOT_IDS)[number];

/**
 * `band-plugin.json`. Every process that loads a plugin validates the
 * manifest with this schema before it runs any plugin code.
 */
export const pluginManifestSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  name: z.string().min(1),
  version: z.string().min(1),
  pluginApi: z.literal(PLUGIN_API_VERSION),
  activationEvents: z.array(activationEventSchema).min(1),
  contributes: z
    .object({
      slots: z.array(z.enum(CLIENT_SLOT_IDS)).default([]),
    })
    .default({}),
  /** External binaries the plugin shells out to. */
  requires: z.array(z.string()).default([]),
});

export type PluginManifest = z.infer<typeof pluginManifestSchema>;

/** Whether a manifest's activation events include `onRepoRemote` for `host`. */
export function matchesRepoRemote(manifest: PluginManifest, host: string): boolean {
  const lower = host.toLowerCase();
  return manifest.activationEvents.some((event) => {
    if (!event.startsWith("onRepoRemote:")) return false;
    return globToRegExp(event.slice("onRepoRemote:".length)).test(lower);
  });
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}
