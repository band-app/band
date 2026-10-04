/**
 * The hub's side of an ephemeral worker's life (plan step 3.5).
 *
 * Sleep. An ephemeral worker that has been idle for its idle time sends
 * `lifecycle.idle`. The hub refuses while a turn, a request waiting on the
 * user, queued messages or a terminal exist for any workspace on that worker.
 * Otherwise it stores each workspace, through ordinary calls on the worker's
 * link, and answers `exit: true` only when all of it is stored:
 *
 *   - The working tree goes into a snapshot commit that sits on top of the
 *     branch head (a temporary index, so the branch and its index stay as
 *     they are). It is pushed to `refs/heads/band/wip/<workspace>` on the
 *     origin remote. When origin is not writable, a git bundle of what the
 *     remotes lack goes into the hub's `<BAND_HOME>/sleep/<workspace>/`. A
 *     snapshot every remote already has needs neither.
 *   - The files of each chat's agent session are read from the worker and
 *     kept in the same directory, so the chat can resume on another machine.
 *
 * Any failure keeps the worker alive and records the error (`lastError`).
 * Ignored files (`.gitignore`) and running processes do not survive.
 *
 * Wake. A message, a terminal or a file call for a workspace that sleeps calls
 * `ensureAwake`. It records a wake request that repeats the placement of the
 * request that made the host. The runner starts a worker with the same id,
 * and when it says hello `restoreHost` checks the snapshot out into a new
 * worktree, puts the uncommitted changes back and restores the agent session
 * files. The chat then reattaches with `session/resume` or `session/load`.
 */

import { rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import type { Host } from "@band-app/host-api";
import { RemoteRpc } from "@band-app/host-remote";
import {
  type LifecycleIdleReply,
  METHOD_LIFECYCLE_EXPORT_SESSIONS,
  METHOD_LIFECYCLE_IDLE,
  METHOD_LIFECYCLE_IMPORT_SESSIONS,
  METHOD_LIFECYCLE_POLICY,
  METHOD_LIFECYCLE_SLEEP,
  type ServerSession,
  type SessionFile,
} from "@band-app/link";
import { createLogger } from "@band-app/logger";
import { toWorkspaceId } from "@band-app/shared/workspace-id";
import { HostRequestQueries } from "../infra/db/queries/host-requests";
import { bandHome } from "../infra/db/queries/settings";
import { WorkspaceSleepQueries, type WorkspaceSleepRow } from "../infra/db/queries/workspace-sleep";
import { WorkspaceQueries } from "../infra/db/queries/workspaces";
import { hostRegistry } from "../infra/host/registry";
import { hasQueuedMessages } from "./_utils/queued-message-store";
import { agentSessionService } from "./agent-session-service";
import { chatService } from "./chat-service";
import { placementService } from "./placement-service";
import { loadState, saveState } from "./state";

const log = createLogger("ephemeral-lifecycle");

const LOCAL_HOST_ID = "local";
/** Beside the worktrees, in the worker's first root, where the path policy allows it. */
const WIP_DIR = ".band-wip";
const WAKE_POLL_MS = 500;
/** On top of the placement timeout, for the checkout after the worker connects. */
const WAKE_GRACE_MS = 5 * 60_000;
/** How long a worker may stay connected after the hub said it could exit. */
const EXIT_GRACE_MS = 60_000;
const BOT = {
  GIT_AUTHOR_NAME: "Band",
  GIT_AUTHOR_EMAIL: "band@localhost",
  GIT_COMMITTER_NAME: "Band",
  GIT_COMMITTER_EMAIL: "band@localhost",
};

export class SleepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SleepError";
  }
}

export type WorkspaceLifecycle = "sleeping" | "waking";

interface Tracked {
  project: string;
  name: string;
  path: string;
  workspaceId: string;
}

/** The hub's idle time for ephemeral workers, from `BAND_EPHEMERAL_IDLE_TIMEOUT_MS`, or undefined to keep the worker's own. */
function idleTimeoutMs(): number | undefined {
  const raw = Number(process.env.BAND_EPHEMERAL_IDLE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

function sleepDir(workspaceId: string): string {
  return join(bandHome(), "sleep", workspaceId);
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class EphemeralLifecycleService {
  private readonly sleeps = new WorkspaceSleepQueries();
  private readonly workspaces = new WorkspaceQueries();
  private readonly requests = new HostRequestQueries();
  private readonly sessions = new Map<string, ServerSession>();
  /** Per host: settles when a worker the hub told to exit has gone, or when the handshake gave up. */
  private readonly draining = new Map<string, Promise<void>>();
  private readonly waking = new Map<string, Promise<void>>();
  private readonly errors = new Map<string, string>();
  /** Per host: why the last hand-off was refused (an agent is working), until one goes through. */
  private readonly blocked = new Map<string, string>();

  // ---- link ---------------------------------------------------------------

  /** Answers `lifecycle.idle` on a worker's session. */
  attach(session: ServerSession): void {
    this.sessions.set(session.workerId, session);
    session.handle(METHOD_LIFECYCLE_IDLE, () => this.onIdle(session));
  }

  /** Sends the hub's idle time to an ephemeral worker that connected. */
  async onConnected(session: ServerSession): Promise<void> {
    const idleExitMs = idleTimeoutMs();
    if (session.hello.mode !== "ephemeral" || idleExitMs === undefined) return;
    try {
      await session.request(METHOD_LIFECYCLE_POLICY, { idleExitMs });
    } catch (err) {
      log.warn(`could not send the idle policy to ${session.workerId}: ${errorText(err)}`);
    }
  }

  // ---- views --------------------------------------------------------------

  /** Whether a workspace sleeps or is waking, or null when it is up. */
  stateOf(workspaceId: string): WorkspaceLifecycle | null {
    const row = this.sleeps.get(workspaceId);
    if (!row) return null;
    return row.wakingSince != null ? "waking" : "sleeping";
  }

  /** Every sleeping or waking workspace, by id. */
  states(): Map<string, WorkspaceLifecycle> {
    return new Map(
      this.sleeps
        .listAll()
        .map((r) => [r.workspaceId, r.wakingSince != null ? "waking" : "sleeping"]),
    );
  }

  /** Why the last attempt to put a host to sleep failed, while its worker still runs. */
  lastError(hostId: string): string | undefined {
    return this.errors.get(hostId);
  }

  /** Why the last hand-off of a host was refused or failed, or undefined when none was. */
  sleepBlocker(hostId: string): string | undefined {
    return this.errors.get(hostId) ?? this.blocked.get(hostId);
  }

  /** Whether a worker of this host is connected on the link. */
  isConnected(hostId: string): boolean {
    return this.sessions.get(hostId)?.attached === true;
  }

  /** Whether the host's workspaces are all stored (`workspace_sleep` rows), so its machine can go. */
  isStored(hostId: string): boolean {
    const stored = new Set(this.sleeps.listByHost(hostId).map((r) => r.workspaceId));
    return this.workspacesOn(hostId).every((w) => stored.has(w.workspaceId));
  }

  /** How many workspaces the hub tracks on a host. */
  workspaceCount(hostId: string): number {
    return this.workspacesOn(hostId).length;
  }

  /** Whether the host's worker is ephemeral, so it can hand its workspaces over. */
  isEphemeral(hostId: string): boolean {
    const session = this.sessions.get(hostId);
    return session?.attached === true && session.hello.mode === "ephemeral";
  }

  /**
   * Asks the connected ephemeral worker to hand its workspaces over now, like an idle one. The
   * worker answers at once and then sends `lifecycle.idle`, so the outcome shows as the worker
   * exiting (or `sleepBlocker` saying why it did not). Returns false when no worker took it.
   */
  async requestSleep(hostId: string): Promise<boolean> {
    const session = this.sessions.get(hostId);
    if (!session?.attached || session.hello.mode !== "ephemeral") return false;
    try {
      const reply = await session.request<{ started?: boolean }>(
        METHOD_LIFECYCLE_SLEEP,
        {},
        { timeoutMs: 15_000 },
      );
      return reply?.started !== false;
    } catch (err) {
      log.warn(`could not ask ${hostId} to sleep: ${errorText(err)}`);
      return false;
    }
  }

  // ---- sleep --------------------------------------------------------------

  private workspacesOn(hostId: string): Tracked[] {
    const out: Tracked[] = [];
    for (const project of loadState().projects) {
      for (const wt of project.worktrees) {
        if (wt.hostId === hostId) {
          out.push({
            project: project.name,
            name: wt.name,
            path: wt.path,
            workspaceId: toWorkspaceId(project.name, wt.name),
          });
        }
      }
    }
    return out;
  }

  private async onIdle(session: ServerSession): Promise<LifecycleIdleReply> {
    const hostId = session.workerId;
    if (session.hello.mode !== "ephemeral") {
      return { exit: false, reason: "the worker is not ephemeral" };
    }
    if (this.draining.has(hostId)) return { exit: false, reason: "already being stored" };

    // From here until the worker is gone, a call that needs the host waits (see `ensureAwake`).
    let release!: () => void;
    this.draining.set(
      hostId,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    let exiting = false;
    try {
      const tracked = this.workspacesOn(hostId);
      const busy = await this.busyReason(hostId, tracked);
      if (busy) {
        this.blocked.set(hostId, busy);
        return { exit: false, reason: busy };
      }
      const rpc = new RemoteRpc(hostId, () => session);
      const host = hostRegistry.hostById(hostId);
      const stored: WorkspaceSleepRow[] = [];
      try {
        for (const ws of tracked) stored.push(await this.persist(host, rpc, ws, hostId));
      } catch (err) {
        // A host stores all of its workspaces or none, so the next wake has nothing half done.
        for (const row of stored) this.forget(row);
        throw err;
      }
      this.errors.delete(hostId);
      this.blocked.delete(hostId);
      log.info(`stored ${tracked.length} workspace(s) of ${hostId}; the worker may exit`);
      exiting = true;
      this.releaseWhenGone(session, hostId, release);
      return { exit: true };
    } catch (err) {
      const message = errorText(err);
      this.errors.set(hostId, message.replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>"));
      log.error(`could not store ${hostId} before it exits: ${message}`);
      return { exit: false, reason: message };
    } finally {
      if (!exiting) {
        this.draining.delete(hostId);
        release();
      }
    }
  }

  /** Holds callers until the worker's link closes. A worker that stays keeps its workspaces, so the sleep rows go. */
  private releaseWhenGone(session: ServerSession, hostId: string, release: () => void): void {
    const done = () => {
      clearTimeout(timer);
      this.draining.delete(hostId);
      release();
    };
    const timer = setTimeout(() => {
      if (!session.attached) return;
      log.warn(`${hostId} did not exit after it was told to; keeping it`);
      for (const row of this.sleeps.listByHost(hostId)) this.forget(row);
      session.off("detached", done);
      done();
    }, EXIT_GRACE_MS);
    timer.unref?.();
    session.once("detached", done);
  }

  private async busyReason(hostId: string, tracked: Tracked[]): Promise<string | null> {
    if (tracked.length === 0 && this.requests.listAwaitingHost().some((r) => r.hostId === hostId)) {
      return "a workspace is still being created on this host";
    }
    const host = hostRegistry.hostById(hostId);
    for (const ws of tracked) {
      for (const chat of chatService.list(ws.workspaceId)) {
        if (agentSessionService.isActive(chat.id) || hasQueuedMessages(chat.id)) {
          return `an agent is working in ${ws.workspaceId}`;
        }
      }
      if ((await host.pty.list(ws.workspaceId)).length > 0) {
        return `a terminal is running in ${ws.workspaceId}`;
      }
    }
    return null;
  }

  private async persist(
    host: Host,
    rpc: RemoteRpc,
    ws: Tracked,
    hostId: string,
  ): Promise<WorkspaceSleepRow> {
    const cwd = ws.path;
    const git = async (args: string[], env?: Record<string, string>) =>
      (await host.exec("git", args, { cwd, env })).stdout.trim();
    const [root] = (await host.info()).roots;
    if (!root) throw new SleepError(`host ${hostId} serves no directory`);
    const wipDir = posix.join(root, WIP_DIR);
    await host.fs.mkdir(wipDir, { recursive: true });

    // The snapshot is built in a temporary index, so the branch and the real index are untouched.
    const baseSha = await git(["rev-parse", "HEAD"]);
    const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
    const indexFile = posix.join(wipDir, `${ws.workspaceId}.index`);
    const env = { ...BOT, GIT_INDEX_FILE: indexFile };
    await host.fs.rm(indexFile, { force: true });
    let snapshotSha: string;
    try {
      await git(["read-tree", "HEAD"], env);
      await git(["add", "-A"], env);
      const tree = await git(["write-tree"], env);
      snapshotSha =
        tree === (await git(["rev-parse", "HEAD^{tree}"]))
          ? baseSha
          : await git(
              ["commit-tree", tree, "-p", baseSha, "-m", `band: snapshot of ${ws.workspaceId}`],
              env,
            );
    } finally {
      await host.fs.rm(indexFile, { force: true }).catch(() => undefined);
    }

    const ref = `refs/heads/band/wip/${ws.workspaceId}`;
    const store = await this.upload(host, git, wipDir, ws.workspaceId, ref, snapshotSha);
    const sessionIds = await this.saveSessions(rpc, ws.workspaceId);

    const row: WorkspaceSleepRow = {
      workspaceId: ws.workspaceId,
      hostId,
      project: ws.project,
      name: ws.name,
      branch: branch === "HEAD" ? "" : branch,
      worktreePath: ws.path,
      baseSha,
      snapshotSha,
      ref,
      store,
      sessionIds,
      wakingSince: null,
      createdAt: Date.now(),
    };
    this.sleeps.insert(row);
    return row;
  }

  /** Gets the snapshot off the worker: to origin, else to the hub, else it must already be on a remote. */
  private async upload(
    host: Host,
    git: (args: string[], env?: Record<string, string>) => Promise<string>,
    wipDir: string,
    workspaceId: string,
    ref: string,
    sha: string,
  ): Promise<WorkspaceSleepRow["store"]> {
    let pushError = "origin has no URL";
    const origin = await git(["remote", "get-url", "origin"]).catch(() => "");
    if (origin) {
      try {
        // A failing hook fails the push, and the snapshot then goes to the hub's bundle store.
        await git(["push", "--force", "origin", `${sha}:${ref}`]);
        const listed = await git(["ls-remote", "origin", ref]);
        if (!listed.startsWith(sha)) throw new Error("origin does not hold the snapshot");
        return "origin";
      } catch (err) {
        pushError = errorText(err);
        log.warn(`${workspaceId}: origin is not writable (${pushError}); trying the hub`);
      }
    }
    const local = `refs/band/wip/${workspaceId}`;
    await git(["update-ref", local, sha]);
    const bundle = posix.join(wipDir, `${workspaceId}.bundle`);
    try {
      await git(["bundle", "create", bundle, local, "--not", "--remotes"]);
    } catch (err) {
      if (/empty bundle/i.test(errorText(err))) return "remote";
      throw new SleepError(`could not bundle the snapshot of ${workspaceId}: ${errorText(err)}`);
    }
    try {
      const dir = sleepDir(workspaceId);
      try {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await writeFile(join(dir, "snapshot.bundle"), await host.fs.readFile(bundle), {
          mode: 0o600,
        });
      } catch (err) {
        throw new SleepError(
          `no writable remote (${pushError}) and the hub cannot keep the snapshot of ${workspaceId}: ${errorText(err)}`,
        );
      }
      return "hub";
    } finally {
      await host.fs.rm(bundle, { force: true }).catch(() => undefined);
    }
  }

  /** Reads the session files of the workspace's chats and keeps them on the hub. Returns the session ids. */
  private async saveSessions(rpc: RemoteRpc, workspaceId: string): Promise<string[]> {
    const ids = chatService
      .list(workspaceId)
      .map((c) => c.activeSessionId)
      .filter((id): id is string => typeof id === "string" && id !== "");
    if (ids.length === 0) return [];
    const { files } = await rpc.call<{ files: SessionFile[] }>(METHOD_LIFECYCLE_EXPORT_SESSIONS, {
      sessionIds: ids,
    });
    if (files.length === 0) return [];
    try {
      const dir = sleepDir(workspaceId);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(join(dir, "sessions.json"), JSON.stringify({ files }), { mode: 0o600 });
    } catch (err) {
      // The chat's log is on the hub, so a chat without its agent files starts a new session with a notice.
      log.warn(`could not keep the agent sessions of ${workspaceId}: ${errorText(err)}`);
      return [];
    }
    return ids;
  }

  private forget(row: WorkspaceSleepRow): void {
    this.sleeps.delete(row.workspaceId);
    rmSync(sleepDir(row.workspaceId), { recursive: true, force: true });
  }

  // ---- wake ---------------------------------------------------------------

  /**
   * Returns once the workspace has a running worker: at once when it is up,
   * after the restore when it sleeps. Call it before using the workspace's
   * host. Background work (pollers, syncs) does not call it, so it does not
   * wake a sleeping workspace.
   */
  async ensureAwake(workspaceId: string): Promise<void> {
    for (let i = 0; i < 3; i++) {
      const hostId = this.workspaces.findHostId(workspaceId);
      if (!hostId || hostId === LOCAL_HOST_ID) return;
      const draining = this.draining.get(hostId);
      if (draining) {
        await draining;
        continue;
      }
      if (!this.sleeps.get(workspaceId)) return;
      await this.wake(hostId);
      return;
    }
    throw new Error(`workspace ${workspaceId} is being stored, retry in a moment`);
  }

  wake(hostId: string): Promise<void> {
    let inflight = this.waking.get(hostId);
    if (!inflight) {
      inflight = this.doWake(hostId).finally(() => this.waking.delete(hostId));
      this.waking.set(hostId, inflight);
    }
    return inflight;
  }

  private async doWake(hostId: string): Promise<void> {
    const rows = this.sleeps.listByHost(hostId);
    const first = rows[0];
    if (!first) return;
    this.sleeps.setWaking(hostId, Date.now());
    try {
      const request = placementService.requestWake(
        { hostId, workspaceIds: rows.map((r) => r.workspaceId) },
        first.project,
        first.name,
      );
      const deadline = Date.now() + placementService.timeoutMs() + WAKE_GRACE_MS;
      for (;;) {
        const current = placementService.get(request.id);
        if (!current) throw new Error(`Wake request ${request.id} is gone`);
        if (current.status === "failed") {
          throw new Error(current.error ?? `Waking ${hostId} failed`);
        }
        if (current.status === "cancelled") throw new Error(`Waking ${hostId} was cancelled`);
        if (current.completedAt != null) return;
        if (Date.now() > deadline) throw new Error(`Waking ${hostId} timed out`);
        await new Promise((r) => setTimeout(r, WAKE_POLL_MS));
      }
    } finally {
      this.sleeps.setWaking(hostId, null);
    }
  }

  /**
   * Restores the sleeping workspaces of `hostId` onto its new worker. Called
   * by placement once the worker said hello.
   */
  async restoreHost(hostId: string, hostProjectPath?: string): Promise<void> {
    const rows = this.sleeps.listByHost(hostId);
    if (rows.length === 0) return;
    const host = hostRegistry.hostById(hostId);
    const session = this.sessions.get(hostId);
    if (!session) throw new Error(`Host ${hostId} is not connected`);
    const rpc = new RemoteRpc(hostId, () => session);
    for (const row of rows) {
      await this.restore(host, rpc, row, hostProjectPath);
    }
  }

  private async restore(
    host: Host,
    rpc: RemoteRpc,
    row: WorkspaceSleepRow,
    hostProjectPath?: string,
  ): Promise<void> {
    const [root] = (await host.info()).roots;
    if (!root) throw new Error(`host ${host.id} serves no directory`);
    if (hostProjectPath) {
      const resolved = await host.fs.realpath(hostProjectPath);
      hostRegistry.setProjectPathOn(row.project, host.id, resolved);
    }
    const repoPath = hostRegistry.projectPathOn(row.project, host.id, "");
    if (!repoPath) {
      throw new Error(`Project "${row.project}" has no checkout on host "${host.id}"`);
    }
    const wipDir = posix.join(root, WIP_DIR);
    await host.fs.mkdir(wipDir, { recursive: true });
    const git = async (args: string[], at = repoPath) =>
      (await host.exec("git", args, { cwd: at })).stdout.trim();

    const local = `refs/band/wip/${row.workspaceId}`;
    if (row.store === "origin") {
      await git(["fetch", "--force", "origin", `${row.ref}:${local}`]);
    } else if (row.store === "hub") {
      const bundle = posix.join(wipDir, `${row.workspaceId}.bundle`);
      await host.fs.writeFile(
        bundle,
        await readFile(join(sleepDir(row.workspaceId), "snapshot.bundle")),
      );
      try {
        await git(["fetch", "--force", bundle, `${local}:${local}`]);
      } finally {
        await host.fs.rm(bundle, { force: true }).catch(() => undefined);
      }
    } else {
      await git(["fetch", "origin"]).catch(() => undefined);
    }
    await git(["cat-file", "-e", `${row.snapshotSha}^{commit}`]);

    const worktreePath = posix.join(root, ".band-worktrees", row.project, row.name);
    await host.fs.mkdir(posix.dirname(worktreePath), { recursive: true });
    await host.fs.rm(worktreePath, { recursive: true, force: true });
    await git(["worktree", "prune"]);
    await git(
      row.branch
        ? ["worktree", "add", "-B", row.branch, worktreePath, row.baseSha]
        : ["worktree", "add", "--detach", worktreePath, row.baseSha],
    );
    if (row.snapshotSha !== row.baseSha) {
      // The working tree becomes the snapshot's, and the index goes back to the branch head, so
      // the edits show up as uncommitted changes again.
      await git(["read-tree", "-u", "--reset", row.snapshotSha], worktreePath);
      await git(["reset", "-q"], worktreePath);
    }
    await host.scripts.copyFiles(repoPath, worktreePath).catch((err) => {
      log.warn(`${row.workspaceId}: could not copy workspace files: ${errorText(err)}`);
    });
    await this.restoreSessions(host, rpc, row, wipDir);
    if (worktreePath !== row.worktreePath) this.moveWorktree(row, worktreePath);

    this.forget(row);
    if (row.store === "origin") {
      await git(["push", "origin", "--delete", row.ref]).catch(() => undefined);
    }
    log.info(`restored ${row.workspaceId} on ${host.id}`);
  }

  private async restoreSessions(
    host: Host,
    rpc: RemoteRpc,
    row: WorkspaceSleepRow,
    wipDir: string,
  ): Promise<void> {
    if (row.sessionIds.length === 0) return;
    let files: SessionFile[];
    try {
      files = (
        JSON.parse(await readFile(join(sleepDir(row.workspaceId), "sessions.json"), "utf8")) as {
          files: SessionFile[];
        }
      ).files;
    } catch (err) {
      log.warn(`${row.workspaceId}: no saved agent sessions: ${errorText(err)}`);
      return;
    }
    const stage = posix.join(wipDir, "sessions", row.workspaceId);
    await host.fs.rm(stage, { recursive: true, force: true });
    for (const file of files) {
      const target = posix.join(stage, file.root, file.rel);
      await host.fs.mkdir(posix.dirname(target), { recursive: true });
      await host.fs.writeFile(target, Buffer.from(file.data, "base64"));
    }
    await rpc.call(METHOD_LIFECYCLE_IMPORT_SESSIONS, { dir: stage });
  }

  /** The checkout moved to another path on the new worker. */
  private moveWorktree(row: WorkspaceSleepRow, path: string): void {
    const state = loadState();
    const project = state.projects.find((p) => p.name === row.project);
    const wt = project?.worktrees.find((w) => w.name === row.name);
    if (!wt) return;
    wt.path = path;
    saveState(state);
  }
}

export const ephemeralLifecycleService = new EphemeralLifecycleService();
