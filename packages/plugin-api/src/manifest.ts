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
export const CLIENT_SLOT_IDS = ["worktree.sideTabs", "worktree.panels"] as const;
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
      /** Worker services the plugin runs. A worker that can run one reports its id as a capability. */
      workerServices: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)).default([]),
      /** Names of the agent tools the plugin registers on the hub. */
      tools: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)).default([]),
    })
    .default({}),
  /**
   * What the plugin needs. An entry with `=` is a worker fact (`os=darwin`, `arch=arm64`), any
   * other entry is a binary that must be on the PATH (`gh`, `xcrun`).
   */
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

/** The `requires` entries split into worker facts (`os=darwin`) and binaries (`xcrun`). */
export function parseRequires(requires: string[]): {
  facts: Record<string, string>;
  binaries: string[];
} {
  const facts: Record<string, string> = {};
  const binaries: string[] = [];
  for (const entry of requires) {
    const at = entry.indexOf("=");
    if (at > 0) facts[entry.slice(0, at)] = entry.slice(at + 1);
    else binaries.push(entry);
  }
  return { facts, binaries };
}
