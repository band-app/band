/**
 * Checkpoints: the hub's own copy of the work in a worktree on a static worker.
 *
 * A checkpoint is the sleep snapshot of `ephemeral-lifecycle-service` (a commit of the working
 * tree built in a temporary index, so the branch, index and files stay as they are) stored on
 * the hub only, never pushed to origin:
 *
 *   - `<BAND_HOME>/checkpoints/<worktree id>/<checkpoint id>/bundle.pack`: a git bundle of what
 *     the worker's remotes lack, so it stays small. Absent when every remote has the snapshot.
 *   - `.../sessions.json`: the files of each chat's agent session.
 *   - the `worktree_checkpoints` row, which says what the two files hold.
 *
 * Triggers: an agent turn that ends, files that stay unchanged for a few minutes while they
 * differ from the last checkpoint, a clean worker shutdown (`lifecycle.shutdown`), and a move.
 * A checkpoint is skipped when the tree, the branch head and the agent sessions are what the
 * newest checkpoint holds. Ignored files are not part of it.
 *
 * With a checkpoint, a worktree whose host is offline stays readable (`changes`, `files`,
 * `file`, run by git on a bare repo the hub builds from the bundles), and can be restored on
 * another host (`restore`) or moved while its host is online (`move`, `evacuate`).
 *
 * Restore never deletes anything on the old host. The copy there is marked superseded and stays
 * on disk until a person removes it. Move removes the source worktree only after the target
 * checked out the same tree.
 */

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import type { Host } from "@band-app/host-api";
import {
  buildSnapshot,
  checkoutSnapshot,
  gitIn,
  resetCheckoutToSnapshot,
  type Snapshot,
  WIP_DIR,
} from "@band-app/host-api/snapshot-git";
import { RemoteRpc } from "@band-app/host-remote";
import {
  METHOD_LIFECYCLE_EXPORT_SESSIONS,
  METHOD_LIFECYCLE_IMPORT_SESSIONS,
  METHOD_LIFECYCLE_SHUTDOWN,
  type ServerSession,
  type SessionFile,
} from "@band-app/link";
import { createLogger } from "@band-app/logger";
import { formatAge } from "@band-app/shared/continuation";
import {
  checkpointsEnabledFor,
  isHostAllowed,
  onlyAvailableOnMessage,
} from "@band-app/shared/repo-hosts";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import { CheckpointError, RepoHostNotAllowedError } from "../errors";
import { RepoQueries } from "../infra/db/queries/repos";
import { CheckpointQueries, type CheckpointRow } from "../infra/db/queries/worktree-checkpoints";
import { clearWorktreeKeyedRows, rekeyWorktreeRows } from "../infra/db/queries/worktree-rekey";
import { hostRegistry } from "../infra/host/registry";
import { checkpointDir, forgetCheckpoints, worktreeCheckpointDir } from "./_utils/checkpoint-store";
import { hasQueuedMessages } from "./_utils/queued-message-store";
import { hostNamesOf } from "./_utils/repo-host-policy";
import { onTurnEnded } from "./_utils/turn-events";
import { agentSessionService } from "./agent-session-service";
import { chatService } from "./chat-service";
import { repoService } from "./repo-service";
import { loadState, saveState } from "./state";
import { hasRunningTask } from "./task-service";
import { terminalService } from "./terminal-service";
import { workerLeaseService } from "./worker-lease-service";
import { worktreeService } from "./worktree-service";

const log = createLogger("checkpoints");

const DEFAULT_KEEP = 5;
const DEFAULT_MAX_BYTES = 200 * 1024 * 1024;
const DEFAULT_QUIET_MS = 3 * 60_000;
const DEFAULT_POLL_MS = 60_000;
/** The largest file `file` returns. A bigger one is reported by size only. */
const MAX_VIEW_BYTES = 1024 * 1024;
const LOCAL_HOST_ID = "local";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

function envNumber(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** How many checkpoints a worktree keeps (`BAND_CHECKPOINT_KEEP`, default 5). */
export const checkpointKeep = () => Math.floor(envNumber("BAND_CHECKPOINT_KEEP", DEFAULT_KEEP));
/** The size above which a checkpoint is skipped (`BAND_CHECKPOINT_MAX_BYTES`, default 200 MB). */
export const checkpointMaxBytes = () => envNumber("BAND_CHECKPOINT_MAX_BYTES", DEFAULT_MAX_BYTES);
const quietMs = () => envNumber("BAND_CHECKPOINT_QUIET_MS", DEFAULT_QUIET_MS);
const pollMs = () => envNumber("BAND_CHECKPOINT_POLL_MS", DEFAULT_POLL_MS);

export type CheckpointTrigger = CheckpointRow["trigger"];

export interface CheckpointView {
  id: string;
  worktreeId: string;
  hostId: string;
  branch: string;
  baseSha: string;
  snapshotSha: string;
  /** Whether the working tree differed from the branch head. */
  dirty: boolean;
  sizeBytes: number;
  trigger: CheckpointTrigger;
  createdAt: number;
  sessions: number;
}

export type TakeResult =
  | { status: "created"; checkpoint: CheckpointView }
  | { status: "unchanged"; checkpoint: CheckpointView }
  | { status: "skipped"; reason: string };

export interface ChangedFile {
  path: string;
  status: string;
  additions: number | null;
  deletions: number | null;
}

export interface RestoreResult {
  /** The worktree on the target host. */
  worktreeId: string;
  hostId: string;
  /** The worktree it replaced, marked superseded. Absent when a move removed it. */
  supersededId?: string;
  /**
   * Refs on the target host (`refs/band/backup/<worktree id>/<time>`) that keep what it held under
   * this name before the checkpoint replaced it. Absent when it held nothing.
   */
  backupRefs?: string[];
  /** For a move: whether the source worktree was removed. */
  sourceRemoved?: boolean;
  /** For a move whose source could not be removed. */
  warning?: string;
  checkpointId: string;
  /** The chats that now belong to the new worktree. */
  chatIds: string[];
}

export interface EvacuateResult {
  fromHostId: string;
  toHostId: string;
  results: Array<{
    worktreeId: string;
    ok: boolean;
    newWorktreeId?: string;
    mode?: "move" | "restore";
    error?: string;
  }>;
}

function toView(row: CheckpointRow): CheckpointView {
  return {
    id: row.id,
    worktreeId: row.worktreeId,
    hostId: row.hostId,
    branch: row.branch,
    baseSha: row.baseSha,
    snapshotSha: row.snapshotSha,
    dirty: row.snapshotSha !== row.baseSha,
    sizeBytes: row.sizeBytes,
    trigger: row.trigger,
    createdAt: row.createdAt,
    sessions: row.sessionIds.length,
  };
}

/** A session file from a worker names a root and a relative path; neither may reach outside the staging directory. */
function isSafeSessionFile(file: SessionFile): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(file.root)) return false;
  if (typeof file.rel !== "string" || file.rel === "" || file.rel.includes("\0")) return false;
  if (posix.isAbsolute(file.rel)) return false;
  const clean = posix.normalize(file.rel);
  return clean !== ".." && !clean.startsWith("../") && clean !== ".";
}

function sessionsHashOf(files: SessionFile[]): string {
  const hash = createHash("sha256");
  for (const f of [...files].sort((a, b) =>
    `${a.root}/${a.rel}`.localeCompare(`${b.root}/${b.rel}`),
  )) {
    hash.update(`${f.root}\0${f.rel}\0${f.data}\0`);
  }
  return hash.digest("hex");
}

interface Watch {
  signature: string;
  changedAt: number;
  /** The signature at the last checkpoint, or at the last "nothing changed" answer. */
  checkpointed?: string;
}

/**
 * Git deletes the empty `refs/band/wip` directory when the last ref in it goes (a checkpoint of
 * another worktree in the same repo ends), which can land between another command's lookup and
 * its create. That command fails with "cannot lock ref", and a second try succeeds.
 */
async function retryRefLock<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      if (attempt >= 4 || !/cannot lock ref/i.test(errorText(err))) throw err;
      await new Promise((r) => setTimeout(r, 50 * attempt));
    }
  }
}

export class CheckpointService {
  private readonly rows = new CheckpointQueries();
  private readonly repos = new RepoQueries();
  private readonly sessions = new Map<string, ServerSession>();
  /** Per worktree: the take in flight, so triggers that overlap run one after the other. */
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly viewLocks = new Map<string, Promise<void>>();
  private readonly watches = new Map<string, Watch>();
  private readonly warnings = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private offTurn: (() => void) | null = null;
  private sweeping = false;
  /** Worktree ids a restore or move is working on. Nothing else checkpoints them meanwhile. */
  private readonly busy = new Set<string>();

  // ---- life cycle ----------------------------------------------------------

  start(): void {
    if (this.timer) return;
    this.offTurn = onTurnEnded((worktreeId) => {
      void this.autoTake(worktreeId, "turn");
    });
    this.timer = setInterval(() => void this.sweep(), pollMs());
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.offTurn?.();
    this.offTurn = null;
  }

  /** Called when a worker's link session starts: answers `lifecycle.shutdown`. */
  attach(session: ServerSession): void {
    this.sessions.set(session.workerId, session);
    session.handle(METHOD_LIFECYCLE_SHUTDOWN, async () => {
      const stored = await this.takeAllOn(session.workerId, "shutdown");
      return { stored };
    });
  }

  // ---- views ---------------------------------------------------------------

  list(worktreeId: string): { checkpoints: CheckpointView[]; warning: string | null } {
    return {
      checkpoints: this.rows.list(worktreeId).map(toView),
      warning: this.warnings.get(worktreeId) ?? null,
    };
  }

  /** Whether a worker's link is up. The hub's own machine is never a checkpoint host. */
  isHostOnline(hostId: string): boolean {
    return this.sessions.get(hostId)?.attached === true;
  }

  /** Whether a worker is ephemeral: it sleeps and wakes instead of being continued elsewhere. */
  isHostEphemeral(hostId: string): boolean {
    return this.sessions.get(hostId)?.hello.mode === "ephemeral";
  }

  /** The stored row of a checkpoint, for the follow-the-work comparison of trees. */
  row(checkpointId: string): CheckpointRow | undefined {
    return this.rows.get(checkpointId);
  }

  /** Whether the worktree's repo keeps checkpoints on the hub. */
  isEnabled(repoName: string): boolean {
    const state = loadState().repos.find((r) => r.name === repoName);
    if (!state) return false;
    return checkpointsEnabledFor(state.checkpointsEnabled, state.allowedHostIds);
  }

  // ---- taking --------------------------------------------------------------

  /** A trigger that nobody waits for. Refusals and failures are logged, never thrown. */
  private async autoTake(worktreeId: string, trigger: CheckpointTrigger): Promise<void> {
    try {
      const reason = this.ineligible(worktreeId);
      if (reason) return;
      await this.take(worktreeId, trigger);
    } catch (err) {
      log.warn({ worktreeId, trigger, err: errorText(err) }, "could not take a checkpoint");
    }
  }

  /** Refuses when a restore or move holds any of the worktrees. */
  private assertNotBusy(...worktreeIds: string[]): void {
    const held = worktreeIds.find((id) => this.busy.has(id));
    if (held) throw new CheckpointError("conflict", `${held} is being restored or moved.`);
  }

  /** Why no automatic checkpoint is taken for the worktree, or null when one may be. */
  private ineligible(worktreeId: string): string | null {
    const found = worktreeService.resolve(worktreeId);
    if (!found) return "unknown worktree";
    const hostId = found.worktree.hostId ?? LOCAL_HOST_ID;
    if (hostId === LOCAL_HOST_ID) return "the worktree is on the hub's own machine";
    if (found.repo.kind !== "git") return "not a git repo";
    if (found.worktree.supersededBy) return "superseded";
    if (this.busy.has(worktreeId)) return "busy";
    if (!checkpointsEnabledFor(found.repo.checkpointsEnabled, found.repo.allowedHostIds)) {
      return "checkpoints are off for this repo";
    }
    const session = this.sessions.get(hostId);
    if (!session?.attached) return "worker offline";
    if (session.hello.mode === "ephemeral") return "ephemeral workers sleep instead";
    return null;
  }

  /**
   * Takes a checkpoint of a worktree on an online worker. `ignoreSetting` lets a move take one of a
   * repo that keeps none; the caller deletes it afterwards.
   */
  take(
    worktreeId: string,
    trigger: CheckpointTrigger,
    opts: { ignoreSetting?: boolean } = {},
  ): Promise<TakeResult> {
    const previous = this.inflight.get(worktreeId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => this.doTake(worktreeId, trigger, opts));
    this.inflight.set(worktreeId, run);
    const clear = () => {
      if (this.inflight.get(worktreeId) === run) this.inflight.delete(worktreeId);
    };
    run.then(clear, clear);
    return run;
  }

  private async takeAllOn(hostId: string, trigger: CheckpointTrigger): Promise<number> {
    let stored = 0;
    for (const w of this.worktreesOn(hostId)) {
      if (this.ineligible(w.worktreeId)) continue;
      try {
        const res = await this.take(w.worktreeId, trigger);
        if (res.status === "created") stored++;
      } catch (err) {
        log.warn({ worktreeId: w.worktreeId, err: errorText(err) }, "shutdown checkpoint failed");
      }
    }
    return stored;
  }

  private worktreesOn(hostId: string): Array<{ repo: string; name: string; worktreeId: string }> {
    const out: Array<{ repo: string; name: string; worktreeId: string }> = [];
    for (const repo of loadState().repos) {
      for (const wt of repo.worktrees) {
        if ((wt.hostId ?? LOCAL_HOST_ID) === hostId) {
          out.push({
            repo: repo.name,
            name: wt.name,
            worktreeId: toWorktreeId(repo.name, wt.name, wt.hostId),
          });
        }
      }
    }
    return out;
  }

  private async doTake(
    worktreeId: string,
    trigger: CheckpointTrigger,
    opts: { ignoreSetting?: boolean },
  ): Promise<TakeResult> {
    const found = worktreeService.resolve(worktreeId);
    if (!found) throw new CheckpointError("invalid", `Unknown worktree "${worktreeId}"`);
    const hostId = found.worktree.hostId ?? LOCAL_HOST_ID;
    if (hostId === LOCAL_HOST_ID) {
      throw new CheckpointError(
        "invalid",
        "Checkpoints are for worktrees on a worker, not on the hub's own machine.",
      );
    }
    // A restore resets this checkout and uses its `refs/band/wip` ref, so no trigger may snapshot it meanwhile.
    this.assertNotBusy(worktreeId);
    if (
      !opts.ignoreSetting &&
      !checkpointsEnabledFor(found.repo.checkpointsEnabled, found.repo.allowedHostIds)
    ) {
      throw new CheckpointError("disabled", `Checkpoints are off for ${found.repo.name}.`);
    }
    const session = this.sessions.get(hostId);
    if (!session?.attached) {
      throw new CheckpointError(
        "offline",
        `Worker ${hostId} is offline, so it cannot be checkpointed.`,
      );
    }
    this.assertOwner(worktreeId, hostId, session);
    const host = hostRegistry.hostById(hostId);
    const rpc = new RemoteRpc(hostId, () => session);
    const [root] = (await host.info()).roots;
    if (!root)
      throw new CheckpointError(
        "invalid",
        `${hostNamesOf([hostId])[0] ?? "unknown worker"} serves no directory.`,
      );
    const wipDir = posix.join(root, WIP_DIR);
    const cwd = found.worktree.path;

    const snap = await buildSnapshot(
      host,
      cwd,
      wipDir,
      worktreeId,
      `band: checkpoint of ${worktreeId}`,
      true,
    );
    const latest = this.rows.latest(worktreeId);
    const sameFiles = latest?.baseSha === snap.baseSha && latest.treeSha === snap.treeSha;
    // The quiet-files trigger only looks at files; the other triggers also notice a longer agent session.
    const checkSessions = trigger !== "quiet";
    let files: SessionFile[] = [];
    if (!sameFiles || checkSessions) files = await this.exportSessions(rpc, worktreeId);
    const sessionsHash = sessionsHashOf(files);
    if (latest && sameFiles && (!checkSessions || latest.sessionsHash === sessionsHash)) {
      await this.markCurrent(worktreeId, host, cwd);
      return { status: "unchanged", checkpoint: toView(latest) };
    }

    // Bundle what the worker's remotes lack. The ref only exists so `git bundle` can name the commit.
    const git = gitIn(host, cwd);
    const ref = `refs/band/wip/${worktreeId}`;
    const remoteBundle = posix.join(wipDir, `${worktreeId}.checkpoint.bundle`);
    await retryRefLock(() => git(["update-ref", ref, snap.snapshotSha]));
    let hasBundle = true;
    let bundleSize = 0;
    try {
      try {
        await git(["bundle", "create", remoteBundle, ref, "--not", "--remotes"]);
        bundleSize = (await host.fs.stat(remoteBundle)).size;
      } catch (err) {
        if (!/empty bundle/i.test(errorText(err))) {
          throw new CheckpointError(
            "invalid",
            `Could not bundle the checkpoint of ${worktreeId}: ${errorText(err)}`,
          );
        }
        hasBundle = false;
      }
      const sessionsJson = files.length > 0 ? JSON.stringify({ files }) : "";
      const sizeBytes = bundleSize + sessionsJson.length;
      const cap = checkpointMaxBytes();
      if (sizeBytes > cap) {
        const reason = `The checkpoint of ${worktreeId} is ${formatBytes(sizeBytes)}, above the ${formatBytes(cap)} limit, so it was skipped.`;
        this.warnings.set(worktreeId, reason);
        log.warn({ worktreeId, sizeBytes, cap }, "checkpoint skipped: over the size limit");
        return { status: "skipped", reason };
      }
      const id = `ckpt_${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
      const dir = checkpointDir(worktreeId, id);
      try {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        if (hasBundle) {
          await writeFile(join(dir, "bundle.pack"), await host.fs.readFile(remoteBundle), {
            mode: 0o600,
          });
        }
        if (sessionsJson)
          await writeFile(join(dir, "sessions.json"), sessionsJson, { mode: 0o600 });
      } catch (err) {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
        throw new CheckpointError(
          "invalid",
          `The hub cannot keep the checkpoint of ${worktreeId}: ${errorText(err)}`,
        );
      }
      const row: CheckpointRow = {
        id,
        worktreeId,
        hostId,
        repo: found.repo.name,
        name: found.worktree.name,
        branch: snap.branch,
        baseSha: snap.baseSha,
        snapshotSha: snap.snapshotSha,
        treeSha: snap.treeSha,
        hasBundle,
        sessionIds: this.sessionIdsOf(worktreeId),
        sessionsHash,
        sizeBytes,
        trigger,
        createdAt: Date.now(),
      };
      // A continuation may have superseded the worktree while the snapshot was being read.
      try {
        this.assertOwner(worktreeId, hostId, session);
      } catch (err) {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
        throw err;
      }
      this.rows.insert(row);
      this.warnings.delete(worktreeId);
      await this.markCurrent(worktreeId, host, cwd);
      await this.prune(worktreeId);
      log.info({ worktreeId, id, trigger, sizeBytes }, "checkpoint taken");
      return { status: "created", checkpoint: toView(row) };
    } finally {
      await git(["update-ref", "-d", ref]).catch(() => undefined);
      await host.fs.rm(remoteBundle, { force: true }).catch(() => undefined);
    }
  }

  /**
   * A checkpoint is stored only for the worktree's current owner: the row is not superseded, it
   * still lives on the sending worker, and that worker's link is the one the snapshot came over.
   * This holds on the store path as well as at the start, so a late shutdown checkpoint that
   * races a continuation is rejected.
   */
  private assertOwner(worktreeId: string, hostId: string, session: ServerSession): void {
    const found = worktreeService.resolve(worktreeId);
    if (!found) throw new CheckpointError("conflict", `${worktreeId} no longer exists.`);
    if (found.worktree.supersededBy) {
      throw new CheckpointError(
        "conflict",
        `${worktreeId} was continued as ${found.worktree.supersededBy}, so ${hostId} no longer owns it.`,
      );
    }
    if (
      (found.worktree.hostId ?? LOCAL_HOST_ID) !== hostId ||
      this.sessions.get(hostId) !== session
    ) {
      throw new CheckpointError(
        "conflict",
        `${hostId} does not own ${worktreeId}, so its checkpoint is not stored.`,
      );
    }
  }

  /** Records the worktree's current file signature as the one a checkpoint holds. */
  private async markCurrent(worktreeId: string, host: Host, cwd: string): Promise<void> {
    try {
      const signature = await this.signatureOf(host, cwd);
      const watch = this.watches.get(worktreeId);
      this.watches.set(worktreeId, {
        signature,
        changedAt: watch?.changedAt ?? Date.now(),
        checkpointed: signature,
      });
    } catch {
      // The sweep reads it again.
    }
  }

  private sessionIdsOf(worktreeId: string): string[] {
    return chatService
      .list(worktreeId)
      .map((c) => c.activeSessionId)
      .filter((id): id is string => typeof id === "string" && id !== "");
  }

  private async exportSessions(rpc: RemoteRpc, worktreeId: string): Promise<SessionFile[]> {
    const ids = this.sessionIdsOf(worktreeId);
    if (ids.length === 0) return [];
    try {
      const { files } = await rpc.call<{ files: SessionFile[] }>(METHOD_LIFECYCLE_EXPORT_SESSIONS, {
        sessionIds: ids,
      });
      return files.filter((f) => {
        const ok = isSafeSessionFile(f);
        if (!ok) log.warn({ worktreeId }, "dropped an agent session file with an unsafe path");
        return ok;
      });
    } catch (err) {
      // The chat log lives on the hub, so a checkpoint without agent files still has the work.
      log.warn({ worktreeId, err: errorText(err) }, "could not read the agent sessions");
      return [];
    }
  }

  /** Keeps the newest N checkpoints, and drops older ones while the total is over the size limit. */
  private async prune(worktreeId: string): Promise<void> {
    const all = this.rows.list(worktreeId);
    const drop: CheckpointRow[] = all.slice(checkpointKeep());
    const kept = all.slice(0, checkpointKeep());
    let total = kept.reduce((n, r) => n + r.sizeBytes, 0);
    while (kept.length > 1 && total > checkpointMaxBytes()) {
      const oldest = kept.pop();
      if (!oldest) break;
      total -= oldest.sizeBytes;
      drop.push(oldest);
    }
    if (drop.length === 0) return;
    this.rows.delete(drop.map((r) => r.id));
    for (const r of drop) {
      await rm(checkpointDir(worktreeId, r.id), { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
    // The view repo keeps objects of dropped checkpoints until it is rebuilt.
    await this.withViewLock(worktreeId, () =>
      rm(join(worktreeCheckpointDir(worktreeId), "view.git"), {
        recursive: true,
        force: true,
      }).catch(() => undefined),
    );
  }

  // ---- the quiet-files trigger ----------------------------------------------

  /** One pass over the online worktrees: take a checkpoint of those whose files stopped changing. */
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const live = new Set<string>();
      for (const repo of loadState().repos) {
        for (const wt of repo.worktrees) {
          const worktreeId = toWorktreeId(repo.name, wt.name, wt.hostId);
          if (this.ineligible(worktreeId)) continue;
          live.add(worktreeId);
          try {
            await this.sweepOne(worktreeId, wt.hostId ?? LOCAL_HOST_ID, wt.path);
          } catch (err) {
            log.debug({ worktreeId, err: errorText(err) }, "checkpoint sweep skipped a worktree");
          }
        }
      }
      for (const id of [...this.watches.keys()]) if (!live.has(id)) this.watches.delete(id);
    } finally {
      this.sweeping = false;
    }
  }

  private async sweepOne(worktreeId: string, hostId: string, path: string): Promise<void> {
    const host = hostRegistry.hostById(hostId);
    const signature = await this.signatureOf(host, path);
    const now = Date.now();
    const watch = this.watches.get(worktreeId);
    if (!watch) {
      // First look since the hub started: whatever is there counts as just changed.
      this.watches.set(worktreeId, { signature, changedAt: now });
      return;
    }
    if (watch.signature !== signature) {
      this.watches.set(worktreeId, { signature, changedAt: now, checkpointed: watch.checkpointed });
      return;
    }
    if (watch.checkpointed === signature || now - watch.changedAt < quietMs()) return;
    await this.take(worktreeId, "quiet");
  }

  /**
   * A cheap fingerprint of a worktree's files: the head, the status and the size of each change.
   * It decides when to build a snapshot, which costs more.
   */
  private async signatureOf(host: Host, cwd: string): Promise<string> {
    const git = gitIn(host, cwd);
    const [head, status, diff] = await Promise.all([
      git(["rev-parse", "HEAD"]),
      git(["status", "--porcelain=v1", "-uall"]),
      git(["diff", "HEAD", "--numstat"]),
    ]);
    return createHash("sha1").update(`${head}\n${status}\n${diff}`).digest("hex");
  }

  // ---- offline views ---------------------------------------------------------

  /**
   * A bare repo on the hub that holds the worktree's checkpoints, built from their bundles. The
   * remote's history is fetched first when the hub can reach it, because a bundle only holds what
   * the remotes lack.
   */
  private viewRepo(
    worktreeId: string,
    row: CheckpointRow,
  ): Promise<{ git: ReturnType<typeof gitIn>; dir: string }> {
    return this.withViewLock(worktreeId, () => this.buildViewRepo(worktreeId, row));
  }

  /** Builds and removals of one worktree's view repo run one at a time, because parallel fetches into a bare repo can fail on ref locks. */
  private withViewLock<T>(worktreeId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.viewLocks.get(worktreeId) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.viewLocks.set(worktreeId, tail);
    void tail.then(() => {
      if (this.viewLocks.get(worktreeId) === tail) this.viewLocks.delete(worktreeId);
    });
    return run;
  }

  private async buildViewRepo(
    worktreeId: string,
    row: CheckpointRow,
  ): Promise<{ git: ReturnType<typeof gitIn>; dir: string }> {
    const local = hostRegistry.local;
    const dir = join(worktreeCheckpointDir(worktreeId), "view.git");
    const git = gitIn(local, dir);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const hasRef = async () =>
      git(["cat-file", "-e", `${row.snapshotSha}^{commit}`]).then(
        () => true,
        () => false,
      );
    await local.exec("git", ["init", "-q", "--bare", dir], {});
    if (await hasRef()) return { git, dir };
    const remote = this.remoteFor(row.repo);
    if (remote) {
      await git(["fetch", "-q", "--force", remote, "+refs/heads/*:refs/remotes/origin/*"]).catch(
        (err) => {
          log.debug(
            { worktreeId, err: errorText(err) },
            "could not fetch the remote for the checkpoint view",
          );
        },
      );
    }
    // Oldest first, so a bundle's prerequisites are there when the next one needs them.
    for (const r of [...this.rows.list(worktreeId)].reverse()) {
      if (!r.hasBundle) continue;
      await git([
        "fetch",
        "-q",
        "--force",
        join(checkpointDir(worktreeId, r.id), "bundle.pack"),
        `refs/band/wip/${worktreeId}:refs/checkpoints/${r.id}`,
      ]).catch((err) => {
        log.debug(
          { worktreeId, id: r.id, err: errorText(err) },
          "could not read a checkpoint bundle",
        );
      });
    }
    if (!(await hasRef())) {
      throw new CheckpointError(
        "no-checkpoint",
        `The checkpoint of ${worktreeId} needs history that only ${row.repo}'s remote has, and the hub cannot reach it.`,
      );
    }
    return { git, dir };
  }

  /** Where the hub can fetch the repo's history from: its remote URL, else its own checkout. */
  private remoteFor(repoName: string): string | null {
    const repo = loadState().repos.find((r) => r.name === repoName);
    if (!repo) return null;
    if (repo.path) return repo.path;
    return repo.remoteUrl ?? null;
  }

  private pick(worktreeId: string, checkpointId?: string): CheckpointRow {
    const row = checkpointId ? this.rows.get(checkpointId) : this.rows.latest(worktreeId);
    if (!row || row.worktreeId !== worktreeId) {
      throw new CheckpointError(
        "no-checkpoint",
        `${worktreeId} has no checkpoint${checkpointId ? ` ${checkpointId}` : ""}.`,
      );
    }
    return row;
  }

  /** The files the checkpoint changed against its branch head, as `git diff` reports them. */
  async changes(
    worktreeId: string,
    checkpointId?: string,
  ): Promise<{ checkpoint: CheckpointView; files: ChangedFile[] }> {
    const row = this.pick(worktreeId, checkpointId);
    if (row.snapshotSha === row.baseSha) return { checkpoint: toView(row), files: [] };
    const { git } = await this.viewRepo(worktreeId, row);
    const [names, stats] = await Promise.all([
      git(["diff", "--name-status", "-z", "--no-renames", row.baseSha, row.snapshotSha]),
      git(["diff", "--numstat", "-z", "--no-renames", row.baseSha, row.snapshotSha]),
    ]);
    const counts = new Map<string, { additions: number | null; deletions: number | null }>();
    for (const entry of stats.split("\0").filter(Boolean)) {
      const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(entry);
      if (m)
        counts.set(m[3], {
          additions: m[1] === "-" ? null : Number(m[1]),
          deletions: m[2] === "-" ? null : Number(m[2]),
        });
    }
    const parts = names.split("\0").filter(Boolean);
    const files: ChangedFile[] = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const path = parts[i + 1];
      files.push({
        path,
        status: parts[i],
        ...(counts.get(path) ?? { additions: null, deletions: null }),
      });
    }
    return { checkpoint: toView(row), files };
  }

  /** The unified diff of one changed file. */
  async diff(worktreeId: string, path: string, checkpointId?: string): Promise<{ diff: string }> {
    const row = this.pick(worktreeId, checkpointId);
    if (row.snapshotSha === row.baseSha) return { diff: "" };
    const { git } = await this.viewRepo(worktreeId, row);
    return { diff: await git(["diff", row.baseSha, row.snapshotSha, "--", path]) };
  }

  /** Every path in the checkpoint's tree. */
  async files(
    worktreeId: string,
    checkpointId?: string,
  ): Promise<{ checkpoint: CheckpointView; paths: string[] }> {
    const row = this.pick(worktreeId, checkpointId);
    const { git } = await this.viewRepo(worktreeId, row);
    const out = await git(["ls-tree", "-r", "--name-only", "-z", row.snapshotSha]);
    return { checkpoint: toView(row), paths: out.split("\0").filter(Boolean) };
  }

  /** One file as the checkpoint holds it. */
  async file(
    worktreeId: string,
    path: string,
    checkpointId?: string,
  ): Promise<{ path: string; size: number; binary: boolean; truncated: boolean; content: string }> {
    const row = this.pick(worktreeId, checkpointId);
    const { git, dir } = await this.viewRepo(worktreeId, row);
    const spec = `${row.snapshotSha}:${path}`;
    const size = Number(
      await git(["cat-file", "-s", spec]).catch(() => {
        throw new CheckpointError("no-checkpoint", `${path} is not in the checkpoint.`);
      }),
    );
    if (size > MAX_VIEW_BYTES) return { path, size, binary: false, truncated: true, content: "" };
    // Not through `git()`, which trims: the file's own trailing newline is part of it.
    const content = (await hostRegistry.local.exec("git", ["cat-file", "blob", spec], { cwd: dir }))
      .stdout;
    const binary = content.includes("\0");
    return { path, size, binary, truncated: false, content: binary ? "" : content };
  }

  // ---- restore and move --------------------------------------------------------

  /**
   * Restores a worktree on `toHostId` from a checkpoint. The source copy is left as it is and
   * marked superseded, so when its host comes back Band does not run both.
   */
  async restore(input: {
    worktreeId: string;
    toHostId: string;
    checkpointId?: string;
    addHost?: boolean;
    hostRepoPath?: string;
  }): Promise<RestoreResult> {
    return this.restoreFrom(input, false);
  }

  private async restoreFrom(
    input: {
      worktreeId: string;
      toHostId: string;
      checkpointId?: string;
      addHost?: boolean;
      hostRepoPath?: string;
    },
    isMove: boolean,
  ): Promise<RestoreResult> {
    const { worktreeId, toHostId } = input;
    const found = worktreeService.resolve(worktreeId);
    if (!found) throw new CheckpointError("invalid", `Unknown worktree "${worktreeId}"`);
    const { repo, worktree } = found;
    const fromHostId = worktree.hostId ?? LOCAL_HOST_ID;
    if (fromHostId === toHostId) {
      throw new CheckpointError(
        "invalid",
        `${worktreeId} is already on ${hostNamesOf([toHostId])[0] ?? "unknown worker"}.`,
      );
    }
    if (toHostId === LOCAL_HOST_ID) {
      throw new CheckpointError(
        "invalid",
        "A worktree can be restored on a worker, not on the hub's own machine.",
      );
    }
    if (worktree.supersededBy) {
      throw new CheckpointError(
        "conflict",
        `${worktreeId} was already restored as ${worktree.supersededBy}.`,
      );
    }
    // The worktree this restore creates or resets on the target.
    const targetId = toWorktreeId(repo.name, worktree.name, toHostId);
    this.assertNotBusy(worktreeId, targetId);
    const row = this.pick(worktreeId, input.checkpointId);
    // An offline source may still be running under its lease. Wait until it has stopped.
    const sourceUp = this.sessions.get(fromHostId)?.attached === true;
    const leaseLeft = sourceUp ? 0 : workerLeaseService.remainingMs(fromHostId);
    if (leaseLeft > 0) {
      throw new CheckpointError(
        "conflict",
        `${fromHostId} may still be running ${worktreeId}: its lease ends in ${formatAge(leaseLeft)}. Try again then.`,
      );
    }
    const target = this.sessions.get(toHostId);
    if (!target?.attached) {
      throw new CheckpointError(
        "offline",
        `Worker ${toHostId} is offline, so it cannot take the worktree.`,
      );
    }
    // The hard rule: the repo must be allowed on the target. The caller may add the host.
    if (!isHostAllowed(repo.allowedHostIds, toHostId)) {
      if (!input.addHost) {
        throw new RepoHostNotAllowedError(
          onlyAvailableOnMessage(repo.name, hostNamesOf(repo.allowedHostIds ?? [])),
          repo.name,
          repo.allowedHostIds ?? [],
        );
      }
    }
    // The default branch is the repo's own checkout on the target, so it is always "already there".
    const isRoot = worktree.name === repo.defaultBranch;
    // A live worktree of this branch on the target is the one the branch belongs to. A superseded
    // older copy is replaced: the checkpoint wins, and what the target holds is backed up first.
    const onTarget = repo.worktrees.find(
      (w) => w.name === worktree.name && (w.hostId ?? LOCAL_HOST_ID) === toHostId,
    );
    if (onTarget && !onTarget.supersededBy && isRoot) {
      // The target's own checkout is reset under whoever is using it, so it must be idle.
      const busy =
        chatService
          .list(targetId)
          .some(
            (chat) =>
              hasRunningTask(chat.id) ||
              agentSessionService.isActive(chat.id) ||
              hasQueuedMessages(chat.id),
          ) || (await terminalService.list(targetId).catch(() => [])).length > 0;
      if (busy) {
        throw new CheckpointError(
          "conflict",
          `${targetId} has a running agent, queued message or terminal on ${toHostId}. Stop it first: opening ${worktreeId} there replaces its files.`,
        );
      }
    }
    if (onTarget && !onTarget.supersededBy && !isRoot) {
      throw new CheckpointError(
        "conflict",
        `Worker ${toHostId} already has a worktree ${worktree.name} of ${repo.name}. Remove it first.`,
      );
    }
    // Again after the awaits above, so two restores into one target can't both pass. Nothing awaits
    // between here and marking both ids busy.
    this.assertNotBusy(worktreeId, targetId);

    // The checkout on the target is refused while the host is not allowed, so widen first and undo it on failure.
    const previousAllowed = repo.allowedHostIds ? [...repo.allowedHostIds] : null;
    let widened = false;
    let restored = false;
    if (!isHostAllowed(repo.allowedHostIds, toHostId)) {
      repoService.setHostPolicy(repo.name, {
        allowedHostIds: [...(repo.allowedHostIds ?? []), toHostId],
      });
      widened = true;
    }

    this.busy.add(worktreeId);
    // The target's copy is reset and checked below, so no automatic checkpoint of it may run meanwhile:
    // the sweep skips a busy worktree, and one it already started is waited for.
    this.busy.add(targetId);
    try {
      await this.inflight.get(targetId)?.catch(() => undefined);
      const host = hostRegistry.hostById(toHostId);
      const rpc = new RemoteRpc(toHostId, () => target);
      const [root] = (await host.info()).roots;
      if (!root)
        throw new CheckpointError(
          "invalid",
          `${hostNamesOf([toHostId])[0] ?? "unknown worker"} serves no directory.`,
        );
      const wipDir = posix.join(root, WIP_DIR);
      await host.fs.mkdir(wipDir, { recursive: true });
      const repoPath = await worktreeService.ensureCheckoutOn(
        repo.name,
        toHostId,
        input.hostRepoPath,
      );
      const git = gitIn(host, repoPath);
      const newId = targetId;
      const worktreePath = isRoot
        ? repoPath
        : posix.join(root, ".band-worktrees", repo.name, worktree.name);
      // What the target holds under this name is saved before the checkpoint replaces it.
      const backups: string[] = [];
      const backupStamp = Date.now();
      const backupRef = (suffix = "") => `refs/band/backup/${newId}/${backupStamp}${suffix}`;
      let oldSnap: Snapshot | undefined;
      if (!isRoot) {
        const exists = await host.fs.stat(worktreePath).then(
          () => true,
          () => false,
        );
        if (exists) {
          const listed = await git(["worktree", "list", "--porcelain"]).catch(() => "");
          const registered = listed.split("\n").includes(`worktree ${worktreePath}`);
          if (!registered) {
            throw new CheckpointError(
              "conflict",
              `${worktreePath} already exists on ${toHostId} and is not a worktree of ${repo.name}.`,
            );
          }
          oldSnap = await buildSnapshot(
            host,
            worktreePath,
            wipDir,
            `${newId}.backup`,
            `band: backup of ${worktreePath} before ${newId}`,
            true,
          );
          await git(["update-ref", backupRef(), oldSnap.snapshotSha]);
          backups.push(backupRef());
          // The folder is moved aside, not deleted: the backup ref holds no ignored files
          // (.env, node_modules), and the old state must not vanish silently.
          const aside = `${worktreePath}.band-backup-${backupStamp}`;
          await host.fs.rename(worktreePath, aside);
          await git(["worktree", "prune"]);
          log.info({ worktreeId, aside }, "kept the target's older copy beside the restored one");
        }
      }

      // Objects first: what origin has, then the checkpoint's bundle for what it lacks.
      await git(["fetch", "origin"]).catch(() => undefined);
      const local = `refs/band/wip/${newId}`;
      if (row.hasBundle) {
        const bundle = posix.join(wipDir, `${newId}.restore.bundle`);
        await host.fs.writeFile(
          bundle,
          await readFile(join(checkpointDir(worktreeId, row.id), "bundle.pack")),
        );
        try {
          await retryRefLock(() =>
            git(["fetch", "--force", bundle, `refs/band/wip/${worktreeId}:${local}`]),
          );
        } finally {
          await host.fs.rm(bundle, { force: true }).catch(() => undefined);
        }
      }
      await git(["cat-file", "-e", `${row.snapshotSha}^{commit}`]).catch(() => {
        throw new CheckpointError(
          "no-checkpoint",
          `Worker ${toHostId} cannot get the commits of the checkpoint: its copy of ${repo.name} lacks them.`,
        );
      });

      let rootBefore: Snapshot | undefined;
      try {
        if (isRoot) {
          // The target's own checkout of the default branch: what it holds is kept, then replaced.
          rootBefore = await buildSnapshot(
            host,
            repoPath,
            wipDir,
            `${newId}.backup`,
            `band: backup of ${repoPath} before ${newId}`,
            true,
          );
          await git(["update-ref", backupRef(), rootBefore.snapshotSha]);
          backups.push(backupRef());
          await resetCheckoutToSnapshot(host, repoPath, row);
        } else {
          await checkoutSnapshot(host, repoPath, worktreePath, row, {
            onDivergentTip: async (tip) => {
              await git(["update-ref", backupRef("-branch"), tip]);
              backups.push(backupRef("-branch"));
            },
          });
          await host.scripts.copyFiles(repoPath, worktreePath).catch((err) => {
            log.warn({ worktreeId, err: errorText(err) }, "could not copy worktree files");
          });
        }
        // Confirm: the same files are there before anything on the hub points at the new copy.
        const check = await buildSnapshot(
          host,
          worktreePath,
          wipDir,
          newId,
          `band: verify ${newId}`,
          true,
        );
        if (check.treeSha !== row.treeSha || check.baseSha !== row.baseSha) {
          throw new CheckpointError(
            "invalid",
            `The restored copy on ${toHostId} does not match the checkpoint.`,
          );
        }
        await this.restoreSessions(host, rpc, row, wipDir, worktree.path, worktreePath);
      } catch (err) {
        // Only what this call changed on the target is undone, from the backup it just made.
        if (isRoot) {
          if (rootBefore)
            await resetCheckoutToSnapshot(host, repoPath, rootBefore).catch(() => undefined);
        } else {
          await git(["worktree", "remove", "--force", worktreePath]).catch(() => undefined);
          await git(["worktree", "prune"]).catch(() => undefined);
          if (oldSnap)
            await checkoutSnapshot(host, repoPath, worktreePath, oldSnap).catch(() => undefined);
        }
        throw err;
      } finally {
        await git(["update-ref", "-d", local]).catch(() => undefined);
      }

      // The hub now points at the new copy: a row for it, the chats and records moved, the old row superseded.
      const state = loadState();
      const stateRepo = state.repos.find((r) => r.name === repo.name);
      if (!stateRepo) throw new CheckpointError("invalid", `Repo ${repo.name} is gone.`);
      // An older copy the target held under this name is replaced by the restored one.
      stateRepo.worktrees = stateRepo.worktrees.filter(
        (w) => !(w.name === worktree.name && (w.hostId ?? LOCAL_HOST_ID) === toHostId),
      );
      stateRepo.worktrees.push({
        name: worktree.name,
        branch: row.branch || worktree.branch,
        path: worktreePath,
        pinned: onTarget?.pinned ?? worktree.pinned,
        hostId: toHostId,
      });
      saveState(state);
      if (onTarget) {
        // `saveAll` keeps what the database holds for a key, and the older copy's marks are stale.
        this.repos.setSupersededBy(repo.name, worktree.name, toHostId, null);
        this.repos.setDivergence(repo.name, worktree.name, toHostId, null);
        this.repos.setContinuedFrom(repo.name, worktree.name, toHostId, null);
        clearWorktreeKeyedRows(newId);
      }
      if (worktree.origin) this.repos.setOrigin(repo.name, worktree.name, worktree.origin);
      if (worktree.groupId) {
        this.repos.setGroup(repo.name, worktree.name, worktree.groupId, toHostId);
      }
      this.repos.setSupersededBy(repo.name, worktree.name, fromHostId, newId);
      // Each worker learns its new blocked list now, not at its next timed renewal.
      await Promise.all([
        workerLeaseService.pushBlockedPaths(fromHostId),
        onTarget ? workerLeaseService.pushBlockedPaths(toHostId) : undefined,
      ]);
      if (isRoot) {
        // The repo lists its default branch from the primary host, which is now the live copy's.
        try {
          repoService.setHostPolicy(repo.name, { primaryHostId: toHostId });
        } catch (err) {
          log.warn({ repo: repo.name, err: errorText(err) }, "could not set the primary host");
        }
      }
      rekeyWorktreeRows(worktreeId, newId);
      const chatIds = chatService.reassignWorktree(worktreeId, newId);
      log.info(
        { worktreeId, newId, checkpoint: row.id, isMove, backups },
        "worktree restored on another worker",
      );
      restored = true;
      return {
        worktreeId: newId,
        hostId: toHostId,
        supersededId: worktreeId,
        checkpointId: row.id,
        chatIds,
        ...(backups.length > 0 ? { backupRefs: backups } : {}),
      };
    } finally {
      if (widened && !restored) {
        try {
          repoService.setHostPolicy(repo.name, { allowedHostIds: previousAllowed });
        } catch (err) {
          log.warn({ repo: repo.name, err: errorText(err) }, "could not undo the allowed hosts");
        }
      }
      this.busy.delete(worktreeId);
      this.busy.delete(targetId);
    }
  }

  private async restoreSessions(
    host: Host,
    rpc: RemoteRpc,
    row: CheckpointRow,
    wipDir: string,
    fromCwd: string,
    toCwd: string,
  ): Promise<void> {
    if (row.sessionIds.length === 0) return;
    let files: SessionFile[];
    try {
      files = (
        JSON.parse(
          await readFile(join(checkpointDir(row.worktreeId, row.id), "sessions.json"), "utf8"),
        ) as {
          files: SessionFile[];
        }
      ).files;
    } catch (err) {
      log.warn(
        { worktreeId: row.worktreeId, err: errorText(err) },
        "the checkpoint has no agent sessions",
      );
      return;
    }
    const stage = posix.join(wipDir, "sessions", `${row.id}`);
    await host.fs.rm(stage, { recursive: true, force: true });
    for (const file of files) {
      if (!isSafeSessionFile(file)) continue;
      const target = posix.join(stage, file.root, file.rel);
      await host.fs.mkdir(posix.dirname(target), { recursive: true });
      await host.fs.writeFile(target, Buffer.from(file.data, "base64"));
    }
    // An older worker ignores the cwds and writes the files where they were exported from.
    await rpc.call(METHOD_LIFECYCLE_IMPORT_SESSIONS, { dir: stage, fromCwd, toCwd });
  }

  /**
   * Moves a worktree whose host is online: a fresh checkpoint, a restore on the target, and then
   * the source worktree is removed, because the target has checked out the same files.
   */
  async move(input: {
    worktreeId: string;
    toHostId: string;
    addHost?: boolean;
    hostRepoPath?: string;
  }): Promise<RestoreResult> {
    const { worktreeId } = input;
    const found = worktreeService.resolve(worktreeId);
    if (!found) throw new CheckpointError("invalid", `Unknown worktree "${worktreeId}"`);
    const fromHostId = found.worktree.hostId ?? LOCAL_HOST_ID;
    if (fromHostId === LOCAL_HOST_ID) {
      throw new CheckpointError("invalid", "Only worktrees on a worker can be moved.");
    }
    if (!this.sessions.get(fromHostId)?.attached) {
      throw new CheckpointError(
        "offline",
        `Worker ${fromHostId} is offline. Restore ${worktreeId} from its last checkpoint instead.`,
      );
    }
    const isRoot = found.worktree.name === found.repo.defaultBranch;
    if (isRoot) {
      // The repo's own clone stays where it is, so nothing is lost, but a running agent or
      // terminal would keep working in a copy that is about to be superseded.
      const busy =
        chatService
          .list(worktreeId)
          .some(
            (chat) =>
              hasRunningTask(chat.id) ||
              agentSessionService.isActive(chat.id) ||
              hasQueuedMessages(chat.id),
          ) || (await terminalService.list(worktreeId).catch(() => [])).length > 0;
      if (busy) {
        throw new CheckpointError(
          "conflict",
          `${worktreeId} has a running agent, queued message or terminal on ${fromHostId}. Stop it first: moving it leaves that copy superseded.`,
        );
      }
    }
    const enabled = checkpointsEnabledFor(found.repo.checkpointsEnabled, found.repo.allowedHostIds);
    const taken = await this.take(worktreeId, "move", { ignoreSetting: !enabled });
    if (taken.status === "skipped") throw new CheckpointError("oversize", taken.reason);
    let result: RestoreResult;
    try {
      result = await this.restoreFrom({ ...input, checkpointId: taken.checkpoint.id }, true);
    } catch (err) {
      // A repo that keeps no checkpoints keeps none after a failed move either.
      if (!enabled) forgetCheckpoints(worktreeId);
      throw err;
    }

    // The target confirmed (restoreFrom compared the trees). The repo's own clone stays,
    // superseded; any other source goes.
    const out: RestoreResult = { ...result };
    if (isRoot) return out;
    try {
      await worktreeService.remove({
        repo: found.repo.name,
        name: found.worktree.name,
        hostId: fromHostId,
      });
      out.sourceRemoved = true;
      delete out.supersededId;
    } catch (err) {
      out.sourceRemoved = false;
      out.warning = `Moved, but the old worktree on ${fromHostId} could not be removed: ${errorText(err)}. It stays listed as superseded.`;
      log.warn({ worktreeId, err: errorText(err) }, "move: could not remove the source worktree");
    }
    // A repo that keeps no checkpoints keeps none after a move either.
    if (!enabled || out.sourceRemoved) forgetCheckpoints(worktreeId);
    return out;
  }

  /**
   * Moves every worktree on a host to another, one after the other. A host that is online
   * moves its worktrees (fresh checkpoint, source removed); an offline host restores from the
   * last checkpoints and leaves its copies superseded. One failure does not stop the rest.
   */
  async evacuate(input: {
    fromHostId: string;
    toHostId: string;
    addHost?: boolean;
  }): Promise<EvacuateResult> {
    const { fromHostId, toHostId } = input;
    if (fromHostId === toHostId)
      throw new CheckpointError("invalid", "Choose another worker to move to.");
    const online = this.sessions.get(fromHostId)?.attached === true;
    const results: EvacuateResult["results"] = [];
    for (const wt of this.evacuable(fromHostId)) {
      try {
        const res = online
          ? await this.move({ worktreeId: wt.worktreeId, toHostId, addHost: input.addHost })
          : await this.restore({ worktreeId: wt.worktreeId, toHostId, addHost: input.addHost });
        results.push({
          worktreeId: wt.worktreeId,
          ok: true,
          newWorktreeId: res.worktreeId,
          mode: online ? "move" : "restore",
        });
      } catch (err) {
        results.push({ worktreeId: wt.worktreeId, ok: false, error: errorText(err) });
      }
    }
    return { fromHostId, toHostId, results };
  }

  /** The worktrees on a host that a move takes along: not superseded, and not a repo's own clone. */
  evacuable(hostId: string): Array<{ repo: string; name: string; worktreeId: string }> {
    const out: Array<{ repo: string; name: string; worktreeId: string }> = [];
    for (const repo of loadState().repos) {
      const clone = hostRegistry.repoPathOn(repo.name, hostId, "");
      for (const wt of repo.worktrees) {
        if ((wt.hostId ?? LOCAL_HOST_ID) !== hostId || wt.supersededBy) continue;
        if (clone && wt.path === clone) continue;
        out.push({
          repo: repo.name,
          name: wt.name,
          worktreeId: toWorktreeId(repo.name, wt.name, wt.hostId),
        });
      }
    }
    return out;
  }
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

export const checkpointService = new CheckpointService();
