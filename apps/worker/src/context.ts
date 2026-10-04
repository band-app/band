import { join } from "node:path";
import type { Host, HostDirs, HostInfo } from "@band-app/host-api";
import type { LinkSession } from "@band-app/link";
import type { Logger } from "@band-app/logger";
import type { ActivityTracker } from "./activity.ts";
import type { PathPolicy } from "./path-policy.ts";
import { asParams, encodeBytes, encodeJson, mapError, type Params } from "./rpc-util.ts";

export interface WorkerContext {
  host: Host;
  session: LinkSession;
  policy: PathPolicy;
  activity: ActivityTracker;
  log: Logger;
  labels: Record<string, string>;
}

/** What `host.info` reports: the host's own facts with this worker's labels and roots. */
export async function describeHost(ctx: WorkerContext): Promise<HostInfo> {
  const info = await ctx.host.info();
  return {
    ...info,
    labels: Object.entries(ctx.labels).map(([k, v]) => `${k}=${v}`),
    roots: ctx.policy.rootPaths,
    dirs: hostDirs(ctx.policy.rootPaths),
  };
}

type Handler<T> = (params: Params, call: { signal: AbortSignal }) => T | Promise<T>;

/** Registers RPC methods, each counted as activity and with errors mapped to RPC codes. */
export class Registrar {
  readonly names: string[] = [];
  constructor(private readonly ctx: WorkerContext) {}

  /** Replies with `fn`'s value, as JSON. */
  json(method: string, fn: Handler<unknown>): void {
    this.add(method, async (p, call) => encodeJson(this.ctx.session, await fn(p, call)));
  }

  /** Replies with the bytes `fn` returns. */
  bytes(method: string, fn: Handler<Uint8Array>): void {
    this.add(method, async (p, call) => encodeBytes(this.ctx.session, await fn(p, call)));
  }

  /** Replies with exactly what `fn` returns, for calls that build their own reply. */
  raw(method: string, fn: Handler<unknown>): void {
    this.add(method, fn);
  }

  private add(method: string, fn: Handler<unknown>): void {
    this.names.push(method);
    this.ctx.session.handle(method, async (raw, call) => {
      const release = this.ctx.activity.hold();
      try {
        return await fn(asParams(raw ?? {}), call);
      } catch (err) {
        throw mapError(err);
      } finally {
        release();
      }
    });
  }
}

/**
 * Where the hub keeps workspace files on this worker: beside the worktrees, in
 * the first root, so the path policy already allows them.
 */
export function hostDirs(roots: string[]): HostDirs | undefined {
  const root = roots[0];
  if (root === undefined) return undefined;
  return { uploads: join(root, ".band-uploads"), shared: join(root, ".band-shared") };
}
