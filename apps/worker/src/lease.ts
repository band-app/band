import { realpath, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { Host } from "@band-app/host-api";
import { buildSnapshot, gitIn } from "@band-app/host-api/snapshot-git";
import type { LeaseRenewReply } from "@band-app/link";
import type { Logger } from "@band-app/logger";

/** One worktree's local snapshot, taken when the lease ran out. */
interface FencedSnapshot {
  path: string;
  baseSha: string;
  snapshotSha: string;
  treeSha: string;
  ref: string;
  at: number;
}

export interface LeaseGuardOptions {
  host: Host;
  /** The worker's private directory, where the fence leaves `fenced.json`. */
  stateDir: string;
  log: Logger;
  /** Every worktree folder on this worker. */
  worktreePaths: () => Promise<string[]>;
}

const safeName = (path: string) => path.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_");

/**
 * The worker's side of the hub's lease (issue #901). The hub renews the lease while the link is
 * up (`lease.renew`). When it runs out, whatever the reason (the hub is gone, the network is
 * down, the hub itself stopped) the worker snapshots every worktree locally, then stops its
 * agents, terminals and run scripts, and refuses to start new ones until a renewal arrives. It
 * cannot tell "the hub is down" from "my network is down", so both fence. A worker that never gets
 * a renewal (an older hub) never fences.
 *
 * The snapshot is a commit of the working tree under `refs/band/fenced/<folder>` in the worktree's
 * repository, and is never uploaded: it is for the divergence check when the hub is back, and
 * the hub never stores it as a checkpoint. Files are not touched.
 */
export class LeaseGuard {
  private expiresAt: number | null = null;
  /** The same expiry on the wall clock, which keeps counting while the machine sleeps. */
  private expiresAtWall: number | null = null;
  private fenced = false;
  private fencing: Promise<void> | null = null;
  private lastSnapshots = 0;
  private blocked: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  private ttlMs = 0;
  private readonly stoppers: Array<() => void | Promise<void>> = [];

  constructor(private readonly options: LeaseGuardOptions) {}

  /** Registers what the fence stops, such as the running agents. */
  onFence(stop: () => void | Promise<void>): void {
    this.stoppers.push(stop);
  }

  /** The hub's renewal: extends the lease, lifts a fence and records the folders another host owns. */
  async renew(ttlMs: number, blockedPaths: string[]): Promise<LeaseRenewReply> {
    // A renewal never lands between a fence's snapshot and its kills.
    await this.fencing;
    this.blocked = await Promise.all(blockedPaths.map((p) => realpath(p).catch(() => resolve(p))));
    this.ttlMs = ttlMs;
    this.expiresAt = performance.now() + ttlMs;
    this.expiresAtWall = Date.now() + ttlMs;
    const reply = { fenced: this.fenced, snapshots: this.fenced ? this.lastSnapshots : 0 };
    if (this.fenced) {
      this.options.log.info("the hub renewed the lease, new work may start again");
      this.fenced = false;
    }
    this.arm();
    return reply;
  }

  /** Throws when a process may not start in `cwd`: the lease ran out, or another host owns the folder. */
  assertMayRun(cwd: string): void {
    // `cwd` is the path the worker's policy resolved, so symlinks are already followed.
    if (this.fenced) {
      throw new Error("This worker lost the hub's lease and stopped its work. Wait for the hub.");
    }
    const at = resolve(cwd);
    for (const dir of this.blocked) {
      if (at === dir || at.startsWith(dir + sep)) {
        throw new Error(`${dir} was continued on another host, so nothing starts here.`);
      }
    }
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private arm(): void {
    if (this.timer) return;
    const every = Math.min(1000, Math.max(50, this.ttlMs / 4));
    this.timer = setInterval(() => {
      const over =
        this.expiresAt !== null &&
        this.expiresAtWall !== null &&
        (performance.now() >= this.expiresAt || Date.now() >= this.expiresAtWall);
      if (over && !this.fenced) {
        void this.fence();
      }
    }, every);
    this.timer.unref();
  }

  private fence(): Promise<void> {
    this.fenced = true;
    this.fencing ??= (async () => {
      const { log } = this.options;
      log.warn("the hub's lease ran out, snapshotting and stopping all work");
      this.lastSnapshots = await this.snapshotAll().catch((err) => {
        log.warn({ message: err instanceof Error ? err.message : String(err) }, "fence snapshot");
        return 0;
      });
      for (const stop of this.stoppers) {
        await Promise.resolve(stop()).catch((err) =>
          log.warn({ message: err instanceof Error ? err.message : String(err) }, "fence stop"),
        );
      }
      log.warn({ snapshots: this.lastSnapshots }, "fenced");
    })().finally(() => {
      this.fencing = null;
    });
    return this.fencing;
  }

  private async snapshotAll(): Promise<number> {
    const { host, stateDir } = this.options;
    const wip = join(stateDir, "fence-wip");
    const done: FencedSnapshot[] = [];
    for (const path of await this.options.worktreePaths()) {
      try {
        const name = safeName(path);
        const snap = await buildSnapshot(host, path, wip, name, `band: fenced ${name}`, true);
        const ref = `refs/band/fenced/${name}`;
        await gitIn(host, path)(["update-ref", ref, snap.snapshotSha]);
        done.push({
          path,
          baseSha: snap.baseSha,
          snapshotSha: snap.snapshotSha,
          treeSha: snap.treeSha,
          ref,
          at: Date.now(),
        });
      } catch (err) {
        this.options.log.warn(
          { path, message: err instanceof Error ? err.message : String(err) },
          "could not snapshot a worktree before fencing",
        );
      }
    }
    await writeFile(join(stateDir, "fenced.json"), `${JSON.stringify(done, null, 2)}\n`, {
      mode: 0o600,
    });
    return done.length;
  }
}
