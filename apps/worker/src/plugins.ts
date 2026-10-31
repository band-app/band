import { accessSync, constants, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import {
  encodeMessageFrame,
  METHOD_PLUGIN_CALL,
  METHOD_PLUGIN_STREAM,
  MessageFrameReader,
  RpcError,
} from "@band-app/link";
import type { Logger } from "@band-app/logger";
import { parseRequires, pluginManifestSchema } from "@band-app/plugin-api";
import type {
  PluginStream,
  ReleaseReason,
  WorkerPlugin,
  WorkerPluginInstance,
} from "@band-app/plugin-api/worker";
import { BUNDLED_WORKER_PLUGINS, type BundledWorkerPlugin } from "./bundled-worker-plugins.ts";
import type { Registrar, WorkerContext } from "./context.ts";
import { RPC_INVALID_PARAMS, str } from "./rpc-util.ts";
import { serve } from "./streams.ts";

interface Running {
  instance: WorkerPluginInstance;
  /** The worktrees the plugin has served: hub key to the folder on this worker. */
  scopes: Map<string, string>;
}

function onPath(bin: string, pathVar: string | undefined): boolean {
  for (const dir of (pathVar ?? "").split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, bin), constants.X_OK);
      return true;
    } catch {}
  }
  return false;
}

/**
 * The worker halves of the bundled plugins. A plugin runs here when the manifest's `requires`
 * hold (worker facts and binaries on the `PATH`) and its own `unavailable()` says nothing against
 * it. The worker reports each one it runs as a capability named by the plugin id. The hub's
 * `plugin.call` reaches a plugin's instance, which keeps state per worktree. The worker releases
 * a worktree's state when the worktree is removed, and everything when the lease fences it or it
 * stops.
 */
export class WorkerPlugins {
  private readonly running = new Map<string, Running>();
  private readonly reasons = new Map<string, string>();

  private constructor(
    private readonly log: Logger,
    private readonly scopesFile: string,
  ) {}

  static async start(options: {
    stateDir: string;
    log: Logger;
    bundled?: BundledWorkerPlugin[];
  }): Promise<WorkerPlugins> {
    const plugins = new WorkerPlugins(options.log, join(options.stateDir, "plugin-scopes.json"));
    for (const entry of options.bundled ?? BUNDLED_WORKER_PLUGINS) {
      const parsed = pluginManifestSchema.safeParse(entry.manifest);
      if (!parsed.success || parsed.data.id !== entry.worker.id) {
        options.log.error({ id: entry.worker.id }, "skipping a worker plugin with a bad manifest");
        continue;
      }
      await plugins.load(parsed.data.requires, entry.worker, options.stateDir);
    }
    return plugins;
  }

  private async load(requires: string[], plugin: WorkerPlugin, stateDir: string): Promise<void> {
    const { facts, binaries } = parseRequires(requires);
    const have: Record<string, string> = { os: process.platform, arch: process.arch };
    let reason: string | null = null;
    for (const [key, want] of Object.entries(facts)) {
      if (have[key] !== want)
        reason = `needs ${key}=${want}, this worker has ${have[key] ?? "none"}`;
    }
    for (const bin of binaries) {
      if (reason === null && !onPath(bin, process.env.PATH)) reason = `${bin} is not on the PATH`;
    }
    const instance =
      reason === null
        ? plugin.create({
            pluginId: plugin.id,
            stateDir,
            log: {
              debug: (m, ...a) => this.log.debug({ plugin: plugin.id }, m, ...(a as never[])),
              info: (m, ...a) => this.log.info({ plugin: plugin.id }, m, ...(a as never[])),
              warn: (m, ...a) => this.log.warn({ plugin: plugin.id }, m, ...(a as never[])),
              error: (m, ...a) => this.log.error({ plugin: plugin.id }, m, ...(a as never[])),
            },
          })
        : null;
    if (instance) reason = (await instance.unavailable?.()) ?? null;
    if (reason !== null || !instance) {
      this.reasons.set(plugin.id, reason ?? "unavailable");
      this.log.info({ plugin: plugin.id, reason }, "worker plugin not available here");
      return;
    }
    this.running.set(plugin.id, { instance, scopes: this.savedScopes(plugin.id) });
  }

  /** The worktrees a plugin served before a restart, so a removal after one still finds them. */
  private savedScopes(pluginId: string): Map<string, string> {
    try {
      const all = JSON.parse(readFileSync(this.scopesFile, "utf8")) as Record<
        string,
        Record<string, string>
      >;
      return new Map(Object.entries(all[pluginId] ?? {}));
    } catch {
      return new Map();
    }
  }

  private saveScopes(): void {
    const all: Record<string, Record<string, string>> = {};
    for (const [id, running] of this.running) all[id] = Object.fromEntries(running.scopes);
    try {
      writeFileSync(this.scopesFile, JSON.stringify(all), { mode: 0o600 });
    } catch (err) {
      this.log.warn({ message: String(err) }, "could not save the worker plugin scopes");
    }
  }

  /** The plugin ids this worker can run. */
  capabilities(): string[] {
    return [...this.running.keys()];
  }

  async call(
    pluginId: string,
    method: string,
    params: unknown,
    worktreeKey: string,
    worktreePath: string,
  ): Promise<unknown> {
    const running = this.running.get(pluginId);
    if (!running) {
      const why = this.reasons.get(pluginId);
      throw new RpcError(
        RPC_INVALID_PARAMS,
        why ? `this worker cannot run ${pluginId}: ${why}` : `unknown plugin ${pluginId}`,
      );
    }
    if (running.scopes.get(worktreeKey) !== worktreePath) {
      running.scopes.set(worktreeKey, worktreePath);
      this.saveScopes();
    }
    return running.instance.call(method, params, { worktreeKey, worktreePath });
  }

  async stream(
    pluginId: string,
    name: string,
    params: unknown,
    worktreeKey: string,
    worktreePath: string,
  ): Promise<PluginStream> {
    const running = this.running.get(pluginId);
    if (!running) {
      const why = this.reasons.get(pluginId);
      throw new RpcError(
        RPC_INVALID_PARAMS,
        why ? `this worker cannot run ${pluginId}: ${why}` : `unknown plugin ${pluginId}`,
      );
    }
    if (!running.instance.stream) {
      throw new RpcError(RPC_INVALID_PARAMS, `${pluginId} has no live streams`);
    }
    if (running.scopes.get(worktreeKey) !== worktreePath) {
      running.scopes.set(worktreeKey, worktreePath);
      this.saveScopes();
    }
    return running.instance.stream(name, params, { worktreeKey, worktreePath });
  }

  /** The worktree at `path` was removed: every plugin deletes its state for it. */
  async releasePath(path: string): Promise<void> {
    await this.release((_key, at) => at === path, "removed");
  }

  /** Stops what every plugin runs for every worktree, keeping its state. */
  async releaseAll(reason: Exclude<ReleaseReason, "removed">): Promise<void> {
    await this.release(() => true, reason);
  }

  async stop(): Promise<void> {
    await this.releaseAll("shutdown");
    await Promise.all(
      [...this.running.values()].map((r) =>
        Promise.resolve(r.instance.stop?.()).catch((err) =>
          this.log.warn({ message: String(err) }, "worker plugin stop"),
        ),
      ),
    );
  }

  private async release(
    match: (key: string, path: string) => boolean,
    reason: ReleaseReason,
  ): Promise<void> {
    let changed = false;
    for (const [id, running] of this.running) {
      for (const [key, path] of [...running.scopes]) {
        if (!match(key, path)) continue;
        if (reason === "removed") {
          running.scopes.delete(key);
          changed = true;
        }
        await Promise.resolve(running.instance.release?.(key, reason)).catch((err) =>
          this.log.warn({ plugin: id, message: String(err) }, "worker plugin release"),
        );
      }
    }
    if (changed) this.saveScopes();
  }
}

/** Serves `plugin.call` and ties the plugins to the lease. */
export function registerPluginMethods(r: Registrar, ctx: WorkerContext): () => Promise<void> {
  const plugins = ctx.plugins;
  if (!plugins) return async () => {};
  r.json(METHOD_PLUGIN_CALL, async (a) => {
    const worktreePath = await ctx.policy.resolve(str(a, "worktreePath"), true);
    ctx.lease.assertMayRun(worktreePath);
    return plugins.call(
      str(a, "pluginId"),
      str(a, "method"),
      a.params,
      str(a, "worktreeKey"),
      worktreePath,
    );
  });
  // One channel carries the stream in both directions as `encodeMessageFrame` messages. The hub
  // resetting the channel closes the plugin's stream.
  r.raw(METHOD_PLUGIN_STREAM, async (a) => {
    const worktreePath = await ctx.policy.resolve(str(a, "worktreePath"), true);
    ctx.lease.assertMayRun(worktreePath);
    const stream = await plugins.stream(
      str(a, "pluginId"),
      str(a, "stream"),
      a.params,
      str(a, "worktreeKey"),
      worktreePath,
    );
    let ch: ReturnType<typeof ctx.session.openChannel>;
    try {
      ch = ctx.session.openChannel("plugin.stream", { pluginId: str(a, "pluginId") });
    } catch (err) {
      stream.close();
      throw err;
    }
    const reader = new MessageFrameReader();
    serve(
      ch,
      (async function* () {
        for await (const message of stream.output) yield encodeMessageFrame(message);
      })(),
      {
        release: ctx.activity.hold(),
        onInput: (chunk) => {
          try {
            for (const message of reader.push(chunk)) stream.write(message);
          } catch {
            ch.reset("bad frame");
          }
        },
        onClosed: () => stream.close(),
      },
    );
    return { chan: ch.id };
  });
  ctx.lease.onFence(() => plugins.releaseAll("fenced"));
  return () => plugins.stop();
}
