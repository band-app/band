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
  workspaceId: string;
  chatId?: string;
}

export interface RelayRegisterParams extends RelayScopeParams {
  token: string;
}

export interface RelayRegisterReply {
  /** The relay's address on the worker, such as `http://127.0.0.1:41234`. */
  url: string;
}

export interface RelayRevokeParams {
  token: string;
}

export interface RelayHttpRequest {
  /** What the worker holds for the caller's token. The hub checks it against the worker's own workspaces. */
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
 * Worker to hub: `CliFetchParams` in, `CliFetchReply` out. The worker asks for
 * the `band` CLI binary built for its own platform, so agents and terminals it
 * starts can run `band` (plan step 2.8).
 */
export const METHOD_CLI_FETCH = "cli.fetch";

export interface CliFetchParams {
  /** `process.platform` of the worker, such as `linux` or `darwin`. */
  platform: string;
  /** `process.arch` of the worker, such as `x64` or `arm64`. */
  arch: string;
  /** SHA-256 of the binary the worker already holds. The hub answers without a body when it matches. */
  have?: string;
}

export type CliFetchReply =
  | { available: false; reason: string }
  | { available: true; sha256: string; size: number; chan?: number };

/**
 * Worker to hub: an ephemeral worker that has been idle for its idle time asks
 * whether it may exit. The hub checks that nothing runs, persists every
 * workspace on the worker through ordinary calls on this link, and answers
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
 * workspace are the ones an idle worker gets. The reaper uses it at a machine's maximum lifetime
 * (plan step 3.7).
 */
export const METHOD_LIFECYCLE_SLEEP = "lifecycle.sleep";

/** Hub to worker: reads the agent session files of the named sessions. See `apps/worker/src/methods-lifecycle.ts`. */
export const METHOD_LIFECYCLE_EXPORT_SESSIONS = "lifecycle.exportSessions";
/** Hub to worker: moves staged session files into the agent session directories. */
export const METHOD_LIFECYCLE_IMPORT_SESSIONS = "lifecycle.importSessions";

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
