/**
 * Background sync of project folders. A project's files are its context repo, mastered on the hub.
 * Every host doing the project's work keeps a working copy in its project folder: the coordinator's
 * host, and each host with a worktree in the project. This service keeps them all in step without
 * anyone pushing or pulling: an edit from an agent, from the project's view in the UI or from any
 * other writer is committed on its host, rebased on the hub and pushed, and the other hosts pull it.
 *
 * Each tick pushes every target (a host's push with nothing to commit stays on that host and makes
 * no network call) and pulls a target only when the hub's head moved since that target last
 * synced. A change on the hub (a worker's push, a context tool, the context browser) runs a tick
 * soon instead of waiting for the next one. Ticks never overlap, and the per-turn pull and push of
 * agent sessions keep running beside this, serialized on each host by its context lock.
 */

import type { ContextSpec, Host } from "@band-app/host-api";
import { createLogger } from "@band-app/logger";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import type { ProjectRow } from "../infra/db/queries/projects";
import { hostRegistry } from "../infra/host/registry";
import { contextRepoPath, contextService, runGit } from "./context-service";
import { ephemeralLifecycleService } from "./ephemeral-lifecycle-service";
import { projectFolderService } from "./project-folder-service";
import { projectService } from "./project-service";
import { tokenService } from "./token-service";
import { vaultService } from "./vault-service";

const log = createLogger("context-autosync");

const LOCAL_HOST_ID = "local";
const DEFAULT_INTERVAL_MS = 5_000;
const SOON_MS = 300;
const MAX_STALE_WAIT = 12;

function intervalMs(): number {
  return Number(process.env.BAND_CONTEXT_AUTOSYNC_MS) || DEFAULT_INTERVAL_MS;
}

interface Target {
  project: ProjectRow;
  host: Host;
  spec: ContextSpec;
  readOnly: boolean;
}

export class ContextAutosyncService {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private rerun = false;
  private stopChanged: (() => void) | null = null;
  /** The hub head each `host:context` copy was at after its last sync. */
  private readonly synced = new Map<string, string>();
  /** The last failure logged per `host:context`, so a host that stays down logs once. */
  private readonly lastError = new Map<string, string>();
  /** Passes left before a stale `host:context` copy is pulled again at the same hub head. */
  private readonly backoff = new Map<string, { head: string; wait: number; left: number }>();

  start(): void {
    if (this.stopChanged) return;
    this.stopChanged = contextService.onChanged(() => this.soon());
    this.schedule(intervalMs());
  }

  stop(): void {
    this.stopChanged?.();
    this.stopChanged = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Runs a tick shortly, for a change made on the hub or a save from the project's view. */
  soon(): void {
    if (!this.stopChanged) return;
    this.schedule(SOON_MS);
  }

  /** Runs one full pass now and resolves when it is done. Ticks never overlap. */
  async syncNow(): Promise<void> {
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.rerun = false;
        await this.pass().catch((err) => log.warn({ err }, "project folder sync failed"));
      } while (this.rerun);
    })().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private schedule(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.syncNow().finally(() => {
        if (this.stopChanged && !this.timer) this.schedule(intervalMs());
      });
    }, delayMs);
    this.timer.unref?.();
  }

  private async pass(): Promise<void> {
    const targets = await this.targets();
    const heads = new Map<string, string | undefined>();
    const head = async (name: string) => {
      if (!heads.has(name)) heads.set(name, await hubHead(name));
      return heads.get(name);
    };
    // Decrypting the vault for its fingerprints is the same work for every target, so once a pass.
    const secrets = targets.some((t) => !t.readOnly) ? vaultService.secretFingerprints() : [];
    for (const t of targets) await this.syncOne(t, head, secrets);
    // A removed project, host or context leaves nothing behind.
    const live = new Set(targets.map((t) => `${t.host.id}:${t.spec.name}`));
    for (const map of [this.synced, this.lastError, this.backoff]) {
      for (const key of map.keys()) if (!live.has(key)) map.delete(key);
    }
  }

  private async syncOne(
    t: Target,
    head: (name: string) => Promise<string | undefined>,
    secrets: ReturnType<typeof vaultService.secretFingerprints>,
  ) {
    const key = `${t.host.id}:${t.spec.name}`;
    try {
      let pushed = false;
      if (!t.readOnly) {
        const [result] = await t.host.context.push({
          contexts: [t.spec],
          message: `sync ${t.host.id}`,
          hostLabel: t.host.id,
          secrets,
        });
        if (result) {
          if (result.conflicts.length > 0) {
            contextService.recordEvent(result.name, t.host.id, "conflict", {
              conflicts: result.conflicts,
            });
          }
          if (result.blocked.length > 0) {
            // Rules and line numbers only: the matched text never leaves the host.
            contextService.recordEvent(result.name, t.host.id, "blocked", {
              findings: result.blocked,
              quarantine: result.quarantine,
            });
          }
          if (result.status === "failed") throw new Error(result.error ?? "push failed");
          pushed = result.status === "pushed";
        }
      }
      // The hub's own host writes the bare repo by path, so nothing else hears about its push.
      if (pushed) contextService.syncSoon(t.spec.name);
      const now = await head(t.spec.name);
      const waiting = this.backoff.get(key);
      if (!pushed && waiting && waiting.head === now && waiting.left > 0) {
        waiting.left -= 1;
      } else if (pushed || !now || this.synced.get(key) !== now) {
        const [pulled] = await t.host.context.pull({ contexts: [t.spec], timeoutMs: 30_000 });
        if (pulled?.status === "missing" || pulled?.status === "denied") {
          throw new Error(pulled.error ?? pulled.status);
        }
        // A pushed copy is at the new head, which this pass's cached head predates.
        const at = pushed ? await hubHead(t.spec.name) : now;
        if (at && pulled?.status !== "stale") {
          this.synced.set(key, at);
          this.backoff.delete(key);
        } else if (pulled?.status === "stale") {
          // A stale copy (the hub did not answer, or a read-only host has changes it cannot push)
          // is tried again after 1, 2, 4, 8 and then 12 passes while the hub's head stays put.
          const wait = Math.min((this.backoff.get(key)?.wait ?? 0) * 2 || 1, MAX_STALE_WAIT);
          if (now) this.backoff.set(key, { head: now, wait, left: wait });
        }
      }
      this.lastError.delete(key);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (this.lastError.get(key) !== message) {
        this.lastError.set(key, message);
        log.warn(
          { host: t.host.id, context: t.spec.name, err: message },
          "could not sync a project folder",
        );
      }
    }
  }

  /**
   * Every project's context on every host doing its work: the coordinator's host and each host
   * with a worktree of the project. A host that is offline, asleep, or lacks the context's labels
   * is left out.
   */
  private async targets(): Promise<Target[]> {
    const online = new Set(
      tokenService
        .listHosts()
        .filter((h) => h.status === "online")
        .map((h) => h.id),
    );
    online.add(LOCAL_HOST_ID);
    let localLabels: string[] | undefined;
    const lifecycle = ephemeralLifecycleService.states();
    const out: Target[] = [];
    for (const project of projectService.rows()) {
      const context = contextService.find(project.contextName);
      if (!context) continue;
      const hostIds = new Set<string>([projectFolderService.hostOf(project).id]);
      for (const w of projectService.allWorktreesOf(project.id)) {
        const id = toWorktreeId(w.repoName, w.name);
        // A sleeping worktree's worker is gone; waking it is not this loop's business.
        if (lifecycle.has(id)) continue;
        hostIds.add(w.hostId ?? LOCAL_HOST_ID);
      }
      for (const hostId of hostIds) {
        if (!online.has(hostId)) continue;
        let host: Host;
        try {
          host = hostRegistry.hostById(hostId);
        } catch {
          continue;
        }
        if (hostId === LOCAL_HOST_ID && localLabels === undefined) {
          localLabels = (await host.info().catch(() => null))?.labels ?? [];
        }
        const labels =
          hostId === LOCAL_HOST_ID ? (localLabels ?? []) : (tokenService.hostLabels(hostId) ?? []);
        if (contextService.forSession("", labels, context).every((r) => r.name !== context.name)) {
          continue;
        }
        out.push({
          project,
          host,
          spec: { name: context.name, kind: "project" },
          readOnly: hostId !== LOCAL_HOST_ID && context.workerAccess === "read-only",
        });
      }
    }
    return out;
  }
}

async function hubHead(name: string): Promise<string | undefined> {
  const r = await runGit(["rev-parse", "--verify", "-q", "HEAD^{commit}"], {
    cwd: contextRepoPath(name),
  }).catch(() => null);
  return r && r.code === 0 ? r.stdout.trim() : undefined;
}

export const contextAutosyncService = new ContextAutosyncService();
