/**
 * The messages of the worker relay (plan step 2.5).
 *
 * A worker listens on loopback for the calls its agents make to the hub (the
 * `band` CLI, the MCP endpoint, agent hooks). The hub issues each agent a
 * token, the worker holds the token's scope, and a call goes up the link as
 * one `relay.http` request. The hub answers with the status and headers and
 * streams the body down a channel.
 */

/** Hub to worker: `RelayRegisterParams` in, `RelayRegisterReply` out. */
export const METHOD_RELAY_REGISTER = "relay.register";
/** Hub to worker: `RelayRevokeParams` in. */
export const METHOD_RELAY_REVOKE = "relay.revoke";
/** Worker to hub: `RelayHttpRequest` in, `RelayHttpReply` out. */
export const METHOD_RELAY_HTTP = "relay.http";

/** Largest request body the relay forwards. A link message is capped at 1 MiB, and base64 adds a third. */
export const RELAY_MAX_BODY_BYTES = 512 * 1024;

export interface RelayScopeParams {
  worktreeId: string;
  chatId?: string;
  terminalId?: string;
}

export interface RelayRegisterParams extends RelayScopeParams {
  token: string;
}

export interface RelayRegisterReply {
  /** The relay's address on the worker, such as `http://127.0.0.1:41234`. */
  url: string;
  /**
   * The `DevToolsActivePort` file of the worktree's browser on the worker. It exists while the
   * browser runs, and its first line is the loopback CDP port (plan step 7.3).
   */
  browserPortFile?: string;
}

export interface RelayRevokeParams {
  token: string;
}

export interface RelayHttpRequest {
  /** What the worker holds for the caller's token. The hub checks it against the worker's own worktrees. */
  scope: RelayScopeParams;
  method: string;
  /** Path and query, as the caller sent them. */
  path: string;
  /** Only the request headers the hub looks at. The caller's credentials are never in here. */
  headers: Record<string, string>;
  /** Base64. */
  body?: string;
}

export interface RelayHttpReply {
  status: number;
  headers: Record<string, string>;
  /** The channel the body comes down. The hub ends it after the last chunk. */
  chan: number;
}

/**
 * Worker to hub: an ephemeral worker that has been idle for its idle time asks
 * whether it may exit. The hub checks that nothing runs, persists every
 * worktree on the worker through ordinary calls on this link, and answers
 * `exit: true` only when all of it is stored (plan step 3.5).
 */
export const METHOD_LIFECYCLE_IDLE = "lifecycle.idle";

export interface LifecycleIdleParams {
  /** How long the worker has been idle, in milliseconds. */
  idleMs: number;
}

export type LifecycleIdleReply = { exit: true } | { exit: false; reason: string };

/** Hub to worker: the idle policy, sent after the worker connects. */
export const METHOD_LIFECYCLE_POLICY = "lifecycle.policy";

export interface LifecyclePolicy {
  /** Idle time before an ephemeral worker asks to exit. Replaces `--idle-exit`. */
  idleExitMs?: number;
}

/**
 * Hub to worker: asks an ephemeral worker to go through the same hand-off as an idle one now. The
 * worker answers at once and sends `lifecycle.idle`, so the hub's checks and the storing of every
 * worktree are the ones an idle worker gets. The reaper uses it at a machine's maximum lifetime
 * (plan step 3.7).
 */
export const METHOD_LIFECYCLE_SLEEP = "lifecycle.sleep";

/**
 * Worker to hub: a worker that was asked to stop tells the hub before it closes the link, so the
 * hub can take a last checkpoint of every worktree on it. The reply says how many it stored. The
 * worker waits for it for a bounded time and stops either way.
 */
export const METHOD_LIFECYCLE_SHUTDOWN = "lifecycle.shutdown";

/** Hub to worker: reads the agent session files of the named sessions. See `apps/worker/src/methods-lifecycle.ts`. */
export const METHOD_LIFECYCLE_EXPORT_SESSIONS = "lifecycle.exportSessions";
/** Hub to worker: moves staged session files into the agent session directories. */
export const METHOD_LIFECYCLE_IMPORT_SESSIONS = "lifecycle.importSessions";

/** `lifecycle.importSessions` parameters. Without the cwds the files land where they were exported from. */
export interface ImportSessionsParams {
  /** Worker path of the staged files, as `<root>/<rel>`. */
  dir: string;
  /** The worktree path the sessions were recorded in. */
  fromCwd?: string;
  /** The worktree path on this worker. With `fromCwd`, session files are re-homed to it. */
  toCwd?: string;
}

export interface SessionFile {
  /** The agent session directory the file came from, such as `claude` or `extra0`. */
  root: string;
  /** Path under that directory. */
  rel: string;
  /** File content, base64. */
  data: string;
}

/**
 * Worker to hub: `GitCredentialParams` in, `GitCredentialReply` out. A git
 * credential helper on the worker asks for the credential of one remote. The
 * hub answers only for a remote of a repository placed on that worker, and
 * the secret goes back to the helper process only. It is never stored on the
 * worker and never logged on either side.
 */
export const METHOD_GIT_CREDENTIAL = "git.credential";

export interface GitCredentialParams {
  /** `https` or `http`, as git names it. */
  protocol: string;
  host: string;
  /** The repository path git sends with `credential.useHttpPath`, such as `owner/repo.git`. */
  path: string;
}

export type GitCredentialReply =
  | { found: false }
  | { found: true; username: string; password: string };

/**
 * Worker to hub: `GhTokenParams` in, `GhTokenReply` out. A worker asks for the token its agents
 * and terminals run `gh` with, as `GH_TOKEN`. The hub answers a worker it started through a
 * runner, or one that sent `optIn`, and the token goes into the environment of the processes the
 * worker starts. It is never written to disk and never logged on either side.
 */
export const METHOD_GH_TOKEN = "gh.token";

export interface GhTokenParams {
  /** The worker's operator asked for the hub's token (`BAND_WORKER_GH_TOKEN=hub`). */
  optIn?: boolean;
}

export type GhTokenReply = { found: false; reason?: string } | { found: true; token: string };

/**
 * Hub to worker: renews the worker's lease (issue #901). While the link is up the hub sends it
 * every fifth of the lease time. A worker whose lease runs out, because it lost the hub or the hub
 * stopped, stops its agents, terminals and run scripts and refuses to start new ones until a renewal
 * arrives. The hub offers "Open on another host" for the worker's worktrees only after the lease it
 * could have granted last has expired, so two copies never run at once.
 */
export const METHOD_LEASE_RENEW = "lease.renew";

export interface LeaseRenewParams {
  /** How long the lease lasts from the moment the worker receives this call. */
  ttlMs: number;
  /**
   * Folders on this worker that another host owns now (a continued worktree's old copy). Nothing
   * is started in them while they are listed, so a superseded copy stays stopped after a fence.
   */
  blockedPaths: string[];
}

export interface LeaseRenewReply {
  /** The lease had run out since the last renewal: the worker stopped its processes. */
  fenced: boolean;
  /** How many worktrees got a local snapshot when it did. */
  snapshots: number;
}

/**
 * Hub to worker: install `{ version }` of `@band-app/worker` with npm and restart through the
 * worker's service manager. The reply `{ ok: true }` comes once the install has succeeded, just
 * before the restart; a failed install is an RPC error and the worker keeps running. Only a worker
 * that reported a `serviceManager` in its hello accepts it. See `apps/worker/src/update.ts`.
 */
export const METHOD_WORKER_UPDATE = "worker.update";
