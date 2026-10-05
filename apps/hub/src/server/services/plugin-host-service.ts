import type { Host } from "@band-app/host-api";
import { createLogger } from "@band-app/logger";
import {
  type ChecksProvider,
  matchesRepoRemote,
  type PluginManifest,
  pluginManifestSchema,
  type RepoInfo,
  type ReviewProvider,
} from "@band-app/plugin-api";
import type { BandServerApi, ServerPlugin } from "@band-app/plugin-api/server";
import { hostRegistry } from "../infra/host/registry";
import { BUNDLED_PLUGINS, type BundledPlugin } from "./bundled-plugins";
import { loadSettings } from "./state";

const log = createLogger("plugin-host");

export type PluginStatus = "inactive" | "active" | "disabled" | "errored";

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  status: PluginStatus;
  /** The last activation error, when `status` is `errored`. */
  error: string | null;
  slots: PluginManifest["contributes"]["slots"];
}

interface LoadedPlugin {
  manifest: PluginManifest;
  server: ServerPlugin;
  status: PluginStatus;
  error: string | null;
  activation: Promise<void> | null;
}

/**
 * Loads the plugins bundled with Band and activates each one when one of its
 * activation events fires. Plugins listed in `plugins.disabled` in
 * `~/.band/settings.json` never activate. A plugin that throws, in
 * `activate` or in a provider call, is logged and skipped; it never takes
 * the server down.
 */
export class PluginHost {
  private plugins: LoadedPlugin[] | null = null;
  private reviewProviders: ReviewProvider[] = [];
  private checksProviders: ChecksProvider[] = [];

  constructor(
    private readonly bundled: BundledPlugin[],
    /** The host a plugin's `exec` runs on. Plugin calls carry a path, not a worktree, so it is the local host until plugins are bound to a worktree's host. */
    private readonly host: () => Host = () => hostRegistry.local,
  ) {}

  /** Activate the plugins that ask for `onStartup`. Called once at boot. */
  async start(): Promise<void> {
    await Promise.all(
      this.load()
        .filter((p) => p.manifest.activationEvents.includes("onStartup"))
        .map((p) => this.activate(p)),
    );
  }

  list(): PluginInfo[] {
    return this.load().map((p) => ({
      id: p.manifest.id,
      name: p.manifest.name,
      version: p.manifest.version,
      status: p.status,
      error: p.error,
      slots: p.manifest.contributes.slots,
    }));
  }

  /** Whether `id` is a bundled plugin that `plugins.disabled` doesn't list. */
  isEnabled(id: string): boolean {
    return this.load().some((p) => p.manifest.id === id && p.status !== "disabled");
  }

  /**
   * The review provider for a repository, activating the plugins whose
   * `onRepoRemote` events match its host first. Null when no enabled
   * plugin handles the host.
   */
  async reviewProviderFor(repo: RepoInfo): Promise<ReviewProvider | null> {
    await this.activateForRemote(repo.host);
    return this.reviewProviders.find((p) => this.safeMatches(p, repo)) ?? null;
  }

  async checksProviderFor(repo: RepoInfo): Promise<ChecksProvider | null> {
    await this.activateForRemote(repo.host);
    return this.checksProviders.find((p) => this.safeMatches(p, repo)) ?? null;
  }

  private load(): LoadedPlugin[] {
    if (this.plugins) return this.plugins;
    const disabled = new Set(loadSettings().plugins?.disabled ?? []);
    const plugins: LoadedPlugin[] = [];
    for (const entry of this.bundled) {
      const parsed = pluginManifestSchema.safeParse(entry.manifest);
      if (!parsed.success) {
        log.error("Skipping plugin with an invalid manifest: %s", parsed.error.message);
        continue;
      }
      const manifest = parsed.data;
      plugins.push({
        manifest,
        server: entry.server,
        status: disabled.has(manifest.id) ? "disabled" : "inactive",
        error: null,
        activation: null,
      });
    }
    this.plugins = plugins;
    return plugins;
  }

  private async activateForRemote(host: string): Promise<void> {
    await Promise.all(
      this.load()
        .filter((p) => matchesRepoRemote(p.manifest, host))
        .map((p) => this.activate(p)),
    );
  }

  private activate(plugin: LoadedPlugin): Promise<void> {
    if (plugin.status === "disabled") return Promise.resolve();
    plugin.activation ??= (async () => {
      const api = this.apiFor(plugin.manifest.id);
      try {
        await plugin.server.activate(api);
        plugin.status = "active";
        log.info("Activated plugin %s", plugin.manifest.id);
      } catch (err) {
        plugin.status = "errored";
        plugin.error = err instanceof Error ? err.message : String(err);
        this.reviewProviders = this.reviewProviders.filter((p) => p.id !== plugin.manifest.id);
        this.checksProviders = this.checksProviders.filter((p) => p.id !== plugin.manifest.id);
        log.error("Plugin %s failed to activate: %s", plugin.manifest.id, plugin.error);
      }
    })();
    return plugin.activation;
  }

  private safeMatches(provider: { id: string; matches(repo: RepoInfo): boolean }, repo: RepoInfo) {
    try {
      return provider.matches(repo);
    } catch (err) {
      log.error("Plugin %s threw in matches(): %s", provider.id, String(err));
      return false;
    }
  }

  private checkProviderId(provider: { id: string }, pluginId: string): boolean {
    if (provider.id === pluginId) return true;
    log.error(
      "Plugin %s registered a provider with id %s; provider ids must equal the plugin id",
      pluginId,
      provider.id,
    );
    return false;
  }

  private apiFor(pluginId: string): BandServerApi {
    const pluginLog = log.child({ plugin: pluginId });
    return {
      pluginId,
      log: {
        debug: (message, ...args) => pluginLog.debug(message, ...(args as never[])),
        info: (message, ...args) => pluginLog.info(message, ...(args as never[])),
        warn: (message, ...args) => pluginLog.warn(message, ...(args as never[])),
        error: (message, ...args) => pluginLog.error(message, ...(args as never[])),
      },
      exec: (bin, args, options) => this.host().exec(bin, args, options),
      providers: {
        // Stored as given, not copied, so a provider written as a class
        // keeps its prototype methods. Its id must be the plugin's id, which
        // is how a plugin that fails to activate gets its providers removed.
        registerReviewProvider: (provider) => {
          if (this.checkProviderId(provider, pluginId)) this.reviewProviders.push(provider);
        },
        registerChecksProvider: (provider) => {
          if (this.checkProviderId(provider, pluginId)) this.checksProviders.push(provider);
        },
      },
    };
  }
}

export const pluginHost = new PluginHost(BUNDLED_PLUGINS);
