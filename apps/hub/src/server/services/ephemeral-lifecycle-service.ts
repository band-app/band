/**
 * The hub's side of an ephemeral worker's life (plan step 3.5).
 *
 * Sleep. An ephemeral worker that has been idle for its idle time sends
 * `lifecycle.idle`. The hub refuses while a turn, a request waiting on the
 * user, queued messages or a terminal exist for any worktree on that worker.
 * Otherwise it stores each worktree, through ordinary calls on the worker's
 * link, and answers `exit: true` only when all of it is stored:
 *
 *   - The working tree goes into a snapshot commit that sits on top of the
 *     branch head (a temporary index, so the branch and its index stay as
 *     they are). It is pushed to `refs/heads/band/wip/<worktree>` on the
 *     origin remote. When origin is not writable, a git bundle of what the
 *     remotes lack goes into the hub's `<BAND_HOME>/sleep/<worktree>/`. A
 *     snapshot every remote already has needs neither.
 *   - The files of each chat's agent session are read from the worker and
 *     kept in the same directory, so the chat can resume on another machine.
 *
 * Any failure keeps the worker alive and records the error (`lastError`).
 * Ignored files (`.gitignore`) and running processes do not survive.
 *
 * When the runner that started the worker has `snapshot` and `restore` hooks
 * (plan step 3.10), the hub also snapshots the machine once the above is
 * stored, lets the worker exit and runs the runner's `destroy`. The stored
 * state stays the fallback: a snapshot that cannot be taken, or restored, costs
 * nothing but the speed and the ignored files.
 *
 * Wake. A message, a terminal or a file call for a worktree that sleeps calls
 * `ensureAwake`. It records a wake request that repeats the placement of the
 * request that made the host. The runner starts a worker with the same id,
 * and when it says hello `restoreHost` checks the snapshot out into a new
 * worktree, puts the uncommitted changes back and restores the agent session
 * files. The chat then reattaches with `session/resume` or `session/load`.
 * A wake that the runner served with `restore` brings the checkout back with
 * the machine's disk, so only the agent session files are written again.
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
import { toWorktreeId } from "@band-app/shared/worktree-id";
import { HostRequestQueries } from "../infra/db/queries/host-requests";
import { ProjectTaskQueries } from "../infra/db/queries/project-tasks";
import { ProjectQueries } from "../infra/db/queries/projects";
import { bandHome } from "../infra/db/queries/settings";
import { WorktreeSleepQueries, type WorktreeSleepRow } from "../infra/db/queries/worktree-sleep";
import { WorktreeQueries } from "../infra/db/queries/worktrees";
import { hostRegistry } from "../infra/host/registry";
import { hasQueuedMessages } from "./_utils/queued-message-store";
import { agentSessionService } from "./agent-session-service";
import { chatService } from "./chat-service";
import { placementService } from "./placement-service";
import { runnerService } from "./runner-service";
import { loadState, saveState } from "./state";
import { hasRunningTask } from "./task-service";

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

export type WorktreeLifecycle = "sleeping" | "waking";

interface Tracked {
  repo: string;
  name: string;
  path: string;
  worktreeId: string;
}

/** The hub's idle time for ephemeral workers, from `BAND_EPHEMERAL_IDLE_TIMEOUT_MS`, or undefined to keep the worker's own. */
function idleTimeoutMs(): number | undefined {
  const raw = Number(process.env.BAND_EPHEMERAL_IDLE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

function sleepDir(worktreeId: string): string {
  return join(bandHome(), "sleep", worktreeId);
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export class EphemeralLifecycleService {
  private readonly sleeps = new WorktreeSleepQueries();
  private readonly worktrees = new WorktreeQueries();
  private readonly requests = new HostRequestQueries();
  private readonly projectTasks = new ProjectTaskQueries();
  private readonly projects = new ProjectQueries();
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

  /** Whether a worktree sleeps or is waking, or null when it is up. */
  stateOf(worktreeId: string): WorktreeLifecycle | null {
    const row = this.sleeps.get(worktreeId);
    if (!row) return null;
    return row.wakingSince != null ? "waking" : "sleeping";
  }

  /** Every sleeping or waking worktree, by id. */
  states(): Map<string, WorktreeLifecycle> {
    return new Map(
      this.sleeps
        .listAll()
        .map((r) => [r.worktreeId, r.wakingSince != null ? "waking" : "sleeping"]),
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

  /** Whether the host's worktrees are all stored (`worktree_sleep` rows), so its machine can go. */
  isStored(hostId: string): boolean {
    // A worktree being created on the host is not tracked yet, and nothing of it is stored.
    if (this.requests.listAwaitingHost().some((r) => r.hostId === hostId)) return false;
    const stored = new Set(this.sleeps.listByHost(hostId).map((r) => r.worktreeId));
    return this.worktreesOn(hostId).every((w) => stored.has(w.worktreeId));
  }

  /** How many worktrees the hub tracks on a host. */
  worktreeCount(hostId: string): number {
    return this.worktreesOn(hostId).length;
  }

  /** Worktree counts for every host, from one read of the state. */
  worktreeCountsByHost(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const repo of loadState().repos) {
      for (const wt of repo.worktrees) {
        if (wt.hostId) counts.set(wt.hostId, (counts.get(wt.hostId) ?? 0) + 1);
      }
    }
    return counts;
  }

  /** Whether the host's worker is ephemeral, so it can hand its worktrees over. */
  isEphemeral(hostId: string): boolean {
    const session = this.sessions.get(hostId);
    return session?.attached === true && session.hello.mode === "ephemeral";
  }

  /**
   * Asks the connected ephemeral worker to hand its worktrees over now, like an idle one. The
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

  private worktreesOn(hostId: string): Tracked[] {
    const out: Tracked[] = [];
    for (const repo of loadState().repos) {
      for (const wt of repo.worktrees) {
        if (wt.hostId === hostId) {
          out.push({
            repo: repo.name,
            name: wt.name,
            path: wt.path,
            worktreeId: toWorktreeId(repo.name, wt.name),
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
      const tracked = this.worktreesOn(hostId);
      const busy = await this.busyReason(hostId, tracked);
      if (busy) {
        this.blocked.set(hostId, busy);
        return { exit: false, reason: busy };
      }
      const rpc = new RemoteRpc(hostId, () => session);
      const host = hostRegistry.hostById(hostId);
      const stored: WorktreeSleepRow[] = [];
      try {
        for (const ws of tracked) stored.push(await this.persist(host, rpc, ws, hostId));
        await this.persistTasks(host, rpc, hostId);
      } catch (err) {
        // A host stores all of its worktrees or none, so the next wake has nothing half done.
        for (const row of stored) this.forget(row);
        this.forgetTasks(hostId);
        throw err;
      }
      this.errors.delete(hostId);
      this.blocked.delete(hostId);
      const snapshotted = await this.snapshotMachine(hostId, tracked);
      log.info(`stored ${tracked.length} worktree(s) of ${hostId}; the worker may exit`);
      exiting = true;
      this.releaseWhenGone(session, hostId, release, snapshotted);
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

  /**
   * Snapshots the machine when its runner can. A failure is not one for the sleep: the git and
   * session state is stored already, and the wake falls back to it.
   */
  private async snapshotMachine(hostId: string, tracked: Tracked[]): Promise<boolean> {
    if (!runnerService.supportsSnapshot(hostId)) return false;
    try {
      return await runnerService.snapshotHost(
        hostId,
        tracked.map((w) => w.worktreeId),
      );
    } catch (err) {
      log.warn(
        `could not snapshot the machine of ${hostId}; a wake restores from git: ${errorText(err)}`,
      );
      return false;
    }
  }

  /**
   * Holds callers until the worker's link closes. A worker that stays keeps its worktrees, so the
   * sleep rows go. With a snapshot taken, the runner's `destroy` runs once the worker is gone, before
   * callers are let through, so it cannot race the restore a waiting caller starts.
   */
  private releaseWhenGone(
    session: ServerSession,
    hostId: string,
    release: () => void,
    snapshotted: boolean,
  ): void {
    const done = () => {
      clearTimeout(timer);
      this.draining.delete(hostId);
      release();
    };
    const gone = () => {
      clearTimeout(timer);
      const destroyed = snapshotted ? runnerService.destroyAfterSleep(hostId) : Promise.resolve();
      void destroyed.catch(() => undefined).finally(done);
    };
    const timer = setTimeout(() => {
      if (!session.attached) return;
      log.warn(`${hostId} did not exit after it was told to; keeping it`);
      for (const row of this.sleeps.listByHost(hostId)) this.forget(row);
      session.off("detached", gone);
      if (snapshotted) void runnerService.dropHostSnapshots(hostId);
      done();
    }, EXIT_GRACE_MS);
    timer.unref?.();
    session.once("detached", gone);
  }

  private async busyReason(hostId: string, tracked: Tracked[]): Promise<string | null> {
    if (tracked.length === 0 && this.requests.listAwaitingHost().some((r) => r.hostId === hostId)) {
      return "a worktree is still being created on this host";
    }
    const host = hostRegistry.hostById(hostId);
    // A task is stored with its worktrees. One with no worktree has nothing a wake could restore it from.
    for (const task of this.projectTasks.all().filter((t) => t.hostId === hostId && t.briefPath)) {
      if (this.projectTasks.membersOf(task.id).length === 0) {
        return `task ${task.name} has no repo yet, so it cannot be stored`;
      }
      for (const chat of chatService.listForTask(task.id)) {
        if (
          hasRunningTask(chat.id) ||
          agentSessionService.isActive(chat.id) ||
          hasQueuedMessages(chat.id)
        ) {
          return `an agent is working in task ${task.name}`;
        }
      }
    }
    for (const ws of tracked) {
      for (const chat of chatService.list(ws.worktreeId)) {
        // A task is running from the submit on, before the agent process has started a turn.
        if (
          hasRunningTask(chat.id) ||
          agentSessionService.isActive(chat.id) ||
          hasQueuedMessages(chat.id)
        ) {
          return `an agent is working in ${ws.worktreeId}`;
        }
      }
      if ((await host.pty.list(ws.worktreeId)).length > 0) {
        return `a terminal is running in ${ws.worktreeId}`;
      }
    }
    return null;
  }

  private async persist(
    host: Host,
    rpc: RemoteRpc,
    ws: Tracked,
    hostId: string,
  ): Promise<WorktreeSleepRow> {
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
    const indexFile = posix.join(wipDir, `${ws.worktreeId}.index`);
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
              ["commit-tree", tree, "-p", baseSha, "-m", `band: snapshot of ${ws.worktreeId}`],
              env,
            );
    } finally {
      await host.fs.rm(indexFile, { force: true }).catch(() => undefined);
    }

    const ref = `refs/heads/band/wip/${ws.worktreeId}`;
    const store = await this.upload(host, git, wipDir, ws.worktreeId, ref, snapshotSha);
    const sessionIds = await this.saveSessions(rpc, ws.worktreeId);

    const row: WorktreeSleepRow = {
      worktreeId: ws.worktreeId,
      hostId,
      repo: ws.repo,
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
    worktreeId: string,
    ref: string,
    sha: string,
  ): Promise<WorktreeSleepRow["store"]> {
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
        log.warn(`${worktreeId}: origin is not writable (${pushError}); trying the hub`);
      }
    }
    const local = `refs/band/wip/${worktreeId}`;
    await git(["update-ref", local, sha]);
    const bundle = posix.join(wipDir, `${worktreeId}.bundle`);
    try {
      await git(["bundle", "create", bundle, local, "--not", "--remotes"]);
    } catch (err) {
      if (/empty bundle/i.test(errorText(err))) return "remote";
      throw new SleepError(`could not bundle the snapshot of ${worktreeId}: ${errorText(err)}`);
    }
    try {
      const dir = sleepDir(worktreeId);
      try {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await writeFile(join(dir, "snapshot.bundle"), await host.fs.readFile(bundle), {
          mode: 0o600,
        });
      } catch (err) {
        throw new SleepError(
          `no writable remote (${pushError}) and the hub cannot keep the snapshot of ${worktreeId}: ${errorText(err)}`,
        );
      }
      return "hub";
    } finally {
      await host.fs.rm(bundle, { force: true }).catch(() => undefined);
    }
  }

  /** Reads the session files of the worktree's chats and keeps them on the hub. Returns the session ids. */
  private async saveSessions(rpc: RemoteRpc, worktreeId: string): Promise<string[]> {
    const ids = chatService
      .list(worktreeId)
      .map((c) => c.activeSessionId)
      .filter((id): id is string => typeof id === "string" && id !== "");
    if (ids.length === 0) return [];
    const { files } = await rpc.call<{ files: SessionFile[] }>(METHOD_LIFECYCLE_EXPORT_SESSIONS, {
      sessionIds: ids,
    });
    if (files.length === 0) return [];
    try {
      const dir = sleepDir(worktreeId);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(join(dir, "sessions.json"), JSON.stringify({ files }), { mode: 0o600 });
    } catch (err) {
      // The chat's log is on the hub, so a chat without its agent files starts a new session with a notice.
      log.warn(`could not keep the agent sessions of ${worktreeId}: ${errorText(err)}`);
      return [];
    }
    return ids;
  }

  // ---- tasks --------------------------------------------------------------

  /** Where a sleeping task's brief and chat sessions are kept on the hub. */
  private taskDir(taskId: string): string {
    return join(bandHome(), "sleep", `task-${taskId}`);
  }

  /**
   * Stores what a task has besides its worktrees: its BRIEF.md and the agent session files of its
   * own chat. The folder itself is made again on the new worker, from the project folder there.
   */
  private async persistTasks(host: Host, rpc: RemoteRpc, hostId: string): Promise<void> {
    for (const task of this.projectTasks.all()) {
      if (task.hostId !== hostId || !task.briefPath) continue;
      const dir = this.taskDir(task.id);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(join(dir, "BRIEF.md"), await host.fs.readFile(task.briefPath), {
        mode: 0o600,
      });
      const ids = chatService
        .listForTask(task.id)
        .map((c) => c.activeSessionId)
        .filter((id): id is string => typeof id === "string" && id !== "");
      let sessionCount = 0;
      if (ids.length > 0) {
        const { files } = await rpc.call<{ files: SessionFile[] }>(
          METHOD_LIFECYCLE_EXPORT_SESSIONS,
          { sessionIds: ids },
        );
        if (files.length > 0) {
          await writeFile(join(dir, "sessions.json"), JSON.stringify({ files }), { mode: 0o600 });
          sessionCount = ids.length;
        }
      }
      await writeFile(
        join(dir, "meta.json"),
        JSON.stringify({ taskId: task.id, hostId, sessions: sessionCount }),
        { mode: 0o600 },
      );
    }
  }

  private forgetTasks(hostId: string): void {
    for (const task of this.projectTasks.all()) {
      if (task.hostId === hostId) rmSync(this.taskDir(task.id), { recursive: true, force: true });
    }
  }

  /**
   * Makes each stored task's folder on the new worker, with its BRIEF.md and chat sessions, and
   * points the task at it. Returns the new folder of each task by id, for its worktrees.
   */
  private async restoreTasks(
    host: Host,
    rpc: RemoteRpc,
    hostId: string,
    root: string,
  ): Promise<Map<string, string>> {
    const folders = new Map<string, string>();
    for (const task of this.projectTasks.all()) {
      if (task.hostId !== hostId || !task.briefPath) continue;
      const dir = this.taskDir(task.id);
      let brief: Buffer;
      try {
        brief = await readFile(join(dir, "BRIEF.md"));
      } catch {
        continue; // not stored by a sleep: the folder is still there
      }
      const project = this.projects.find(task.projectId);
      if (!project) continue;
      const { folder } = await host.project.ensure({
        project: project.name,
        repos: [],
        fetch: "never",
      });
      const taskFolder = posix.join(folder, "tasks", task.name);
      await host.fs.mkdir(taskFolder, { recursive: true });
      const briefPath = posix.join(taskFolder, "BRIEF.md");
      await host.fs.writeFile(briefPath, brief);
      this.projectTasks.setHost(task.id, hostId, briefPath);
      folders.set(task.id, taskFolder);
      try {
        const files = (
          JSON.parse(await readFile(join(dir, "sessions.json"), "utf8")) as { files: SessionFile[] }
        ).files;
        const stage = posix.join(root, WIP_DIR, "sessions", `task-${task.id}`);
        await host.fs.rm(stage, { recursive: true, force: true });
        for (const file of files) {
          const target = posix.join(stage, file.root, file.rel);
          await host.fs.mkdir(posix.dirname(target), { recursive: true });
          await host.fs.writeFile(target, Buffer.from(file.data, "base64"));
        }
        await rpc.call(METHOD_LIFECYCLE_IMPORT_SESSIONS, { dir: stage });
      } catch (err) {
        log.warn(`task ${task.name}: no saved agent sessions: ${errorText(err)}`);
      }
    }
    return folders;
  }

  private forget(row: WorktreeSleepRow): void {
    this.sleeps.delete(row.worktreeId);
    rmSync(sleepDir(row.worktreeId), { recursive: true, force: true });
  }

  // ---- wake ---------------------------------------------------------------

  /**
   * Returns once the worktree has a running worker: at once when it is up,
   * after the restore when it sleeps. Call it before using the worktree's
   * host. Background work (pollers, syncs) does not call it, so it does not
   * wake a sleeping worktree.
   */
  async ensureAwake(worktreeId: string): Promise<void> {
    for (let i = 0; i < 3; i++) {
      const hostId = this.worktrees.findHostId(worktreeId);
      if (!hostId || hostId === LOCAL_HOST_ID) return;
      const draining = this.draining.get(hostId);
      if (draining) {
        await draining;
        continue;
      }
      if (!this.sleeps.get(worktreeId)) return;
      await this.wake(hostId);
      return;
    }
    throw new Error(`worktree ${worktreeId} is being stored, retry in a moment`);
  }

  /**
   * Like `ensureAwake`, for a task: wakes its host when the task's worktrees sleep. A task with no
   * worktree is never stored, so it is never asleep.
   */
  async ensureAwakeTask(taskId: string): Promise<void> {
    const task = this.projectTasks.find(taskId);
    const hostId = task?.hostId;
    if (!task || !hostId || hostId === LOCAL_HOST_ID) return;
    for (const member of this.projectTasks.membersOf(task.id)) {
      if (member.worktreeId) {
        await this.ensureAwake(member.worktreeId);
        return;
      }
    }
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
        { hostId, worktreeIds: rows.map((r) => r.worktreeId) },
        first.repo,
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
   * Restores the sleeping worktrees of `hostId` onto its new worker. Called
   * by placement once the worker said hello.
   */
  async restoreHost(hostId: string, hostRepoPath?: string, pathRepo?: string): Promise<void> {
    const rows = this.sleeps.listByHost(hostId);
    if (rows.length === 0) return;
    const host = hostRegistry.hostById(hostId);
    const session = this.sessions.get(hostId);
    if (!session) throw new Error(`Host ${hostId} is not connected`);
    const rpc = new RemoteRpc(hostId, () => session);
    // A restore hook put the machine's disk back, so the checkouts may be there already.
    const fromSnapshot = runnerService.restoredSnapshot(hostId) !== undefined;
    const [root] = (await host.info()).roots;
    const taskFolders = root
      ? await this.restoreTasks(host, rpc, hostId, root)
      : new Map<string, string>();
    for (const row of rows) {
      await this.restore(
        host,
        rpc,
        row,
        // The path the runner reports is the clone of the repo the request was made for. Another repo on the host is cloned again.
        pathRepo === undefined || pathRepo === row.repo ? hostRepoPath : undefined,
        fromSnapshot,
        taskFolders,
      );
    }
    for (const taskId of taskFolders.keys()) {
      rmSync(this.taskDir(taskId), { recursive: true, force: true });
    }
    // The snapshots are used up, or stale when a fresh worker came up after a failed restore.
    void runnerService.dropHostSnapshots(hostId);
  }

  private async restore(
    host: Host,
    rpc: RemoteRpc,
    row: WorktreeSleepRow,
    hostRepoPath?: string,
    fromSnapshot = false,
    taskFolders: Map<string, string> = new Map(),
  ): Promise<void> {
    const [root] = (await host.info()).roots;
    if (!root) throw new Error(`host ${host.id} serves no directory`);
    if (fromSnapshot && (await this.checkoutSurvived(host, row))) {
      await this.finishFromDisk(host, rpc, row, root);
      return;
    }
    if (hostRepoPath) {
      const resolved = await host.fs.realpath(hostRepoPath);
      hostRegistry.setRepoPathOn(row.repo, host.id, resolved);
    }
    let repoPath = hostRegistry.repoPathOn(row.repo, host.id, "");
    // A new machine has none of the clones the old one made, so a repo with a remote is cloned again.
    const remoteUrl = loadState().repos.find((r) => r.name === row.repo)?.remoteUrl;
    if (
      remoteUrl &&
      (!repoPath ||
        !(await host.fs.stat(repoPath).then(
          () => true,
          () => false,
        )))
    ) {
      const defaultBranch =
        loadState().repos.find((r) => r.name === row.repo)?.defaultBranch ?? "main";
      repoPath = (await host.repos.ensure({ remoteUrl, defaultBranch })).path;
      hostRegistry.setRepoPathOn(row.repo, host.id, repoPath);
    }
    if (!repoPath) {
      throw new Error(`Repo "${row.repo}" has no checkout on host "${host.id}"`);
    }
    const wipDir = posix.join(root, WIP_DIR);
    await host.fs.mkdir(wipDir, { recursive: true });
    const git = async (args: string[], at = repoPath) =>
      (await host.exec("git", args, { cwd: at })).stdout.trim();

    const local = `refs/band/wip/${row.worktreeId}`;
    if (row.store === "origin") {
      await git(["fetch", "--force", "origin", `${row.ref}:${local}`]);
    } else if (row.store === "hub") {
      const bundle = posix.join(wipDir, `${row.worktreeId}.bundle`);
      await host.fs.writeFile(
        bundle,
        await readFile(join(sleepDir(row.worktreeId), "snapshot.bundle")),
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

    // A member of a task goes back into its task folder, which is on the new worker by now.
    const member = this.projectTasks.memberOfWorktree(row.worktreeId);
    const taskFolder = member ? taskFolders.get(member.task.id) : undefined;
    const worktreePath = taskFolder
      ? posix.join(taskFolder, row.repo)
      : posix.join(root, ".band-worktrees", row.repo, row.name);
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
      log.warn(`${row.worktreeId}: could not copy worktree files: ${errorText(err)}`);
    });
    await this.restoreSessions(host, rpc, row, wipDir);
    if (worktreePath !== row.worktreePath) this.moveWorktree(row, worktreePath);

    this.forget(row);
    if (row.store === "origin") {
      await git(["push", "origin", "--delete", row.ref]).catch(() => undefined);
    }
    log.info(`restored ${row.worktreeId} on ${host.id}`);
  }

  /** Whether the checkout the sleep stored is on this machine at the commit it had. */
  private async checkoutSurvived(host: Host, row: WorktreeSleepRow): Promise<boolean> {
    try {
      const head = (
        await host.exec("git", ["rev-parse", "HEAD"], { cwd: row.worktreePath })
      ).stdout.trim();
      return head === row.baseSha;
    } catch {
      return false;
    }
  }

  /** The machine came back from a snapshot with the checkout on it. Only the sleep's own records are left to clear. */
  private async finishFromDisk(
    host: Host,
    rpc: RemoteRpc,
    row: WorktreeSleepRow,
    root: string,
  ): Promise<void> {
    const wipDir = posix.join(root, WIP_DIR);
    await host.fs.mkdir(wipDir, { recursive: true });
    await this.restoreSessions(host, rpc, row, wipDir);
    this.forget(row);
    if (row.store === "origin") {
      await host
        .exec("git", ["push", "origin", "--delete", row.ref], { cwd: row.worktreePath })
        .catch(() => undefined);
    }
    log.info(`restored ${row.worktreeId} on ${host.id} from a machine snapshot`);
  }

  private async restoreSessions(
    host: Host,
    rpc: RemoteRpc,
    row: WorktreeSleepRow,
    wipDir: string,
  ): Promise<void> {
    if (row.sessionIds.length === 0) return;
    let files: SessionFile[];
    try {
      files = (
        JSON.parse(await readFile(join(sleepDir(row.worktreeId), "sessions.json"), "utf8")) as {
          files: SessionFile[];
        }
      ).files;
    } catch (err) {
      log.warn(`${row.worktreeId}: no saved agent sessions: ${errorText(err)}`);
      return;
    }
    const stage = posix.join(wipDir, "sessions", row.worktreeId);
    await host.fs.rm(stage, { recursive: true, force: true });
    for (const file of files) {
      const target = posix.join(stage, file.root, file.rel);
      await host.fs.mkdir(posix.dirname(target), { recursive: true });
      await host.fs.writeFile(target, Buffer.from(file.data, "base64"));
    }
    await rpc.call(METHOD_LIFECYCLE_IMPORT_SESSIONS, { dir: stage });
  }

  /** The checkout moved to another path on the new worker. */
  private moveWorktree(row: WorktreeSleepRow, path: string): void {
    const state = loadState();
    const repo = state.repos.find((p) => p.name === row.repo);
    const wt = repo?.worktrees.find((w) => w.name === row.name);
    if (!wt) return;
    wt.path = path;
    saveState(state);
  }
}

export const ephemeralLifecycleService = new EphemeralLifecycleService();
