import { join } from "node:path";
import type { DaemonIdentity } from "../../daemon-kit/connection";
import { type DaemonPaths, daemonPathsFor } from "../../daemon-kit/protocol";

/**
 * Wire protocol between a worker and its agent daemon (docs/architecture/agent-daemon.md).
 *
 * Bump on any change to the messages below that an older peer would misread. The version is in
 * every runtime file name, so a daemon of another version keeps its own endpoint and its agents
 * (unlike the terminal daemon, a newer worker never asks it to exit: that would kill agents).
 * The hello / mismatch exchange is shared with the other daemons and never changes.
 */
export const PROTOCOL_VERSION = 1;

export const IDENTITY: DaemonIdentity = { label: "Agent daemon", protocol: PROTOCOL_VERSION };

/** What a daemon answers `spawn` with once another daemon has replaced its endpoint. */
export const ENDPOINT_LOST_ERROR = "Agent daemon no longer owns its endpoint";

/** The agent daemon keeps its socket, token, pid record and log here, apart from the terminal daemon's. */
export function agentRunDir(stateDir: string): string {
  return join(stateDir, "run", "agents");
}

export function agentDaemonPaths(runDir: string, version = PROTOCOL_VERSION): DaemonPaths {
  return daemonPathsFor({ runDir, name: "agent-daemon", shortPrefix: "ad", version });
}

export type AgentStreamName = "stdout" | "stderr";

/** An agent the daemon holds. Never carries the launch environment. */
export interface AgentRecord {
  agentId: string;
  pid: number | null;
  cwd: string;
  startedAt: number;
  /** The hub's launch-spec hash, opaque to the daemon. */
  specHash: string | null;
  adapterVersion: string | null;
  /** The environment held a GitHub token from the hub's vault. */
  ghToken: boolean;
  /** Bytes the daemon has written to the agent's stdin. */
  stdinWritten: number;
  /** Set once the agent has exited. The record stays until the hub forgets it. */
  exit: { code: number | null; signal: string | null } | null;
}

export interface SpawnParams {
  /** The complete environment for the process. Held in memory only. */
  env: Record<string, string>;
  cwd: string;
  command: string;
  args: string[];
  specHash: string | null;
  adapterVersion: string | null;
  ghToken: boolean;
}

/** Request name -> [params, result]. Answered on the control connection. */
export interface DaemonRequests {
  spawn: [SpawnParams, AgentRecord];
  /** Subscribes this client's stream connection from these byte offsets. */
  attach: [{ agentId: string; stdout: number; stderr: number }, AgentRecord | null];
  /** Releases output up to these offsets and answers with the stdin offset. */
  ack: [{ agentId: string; stdout: number; stderr: number }, { stdin: number } | null];
  /** Base64 bytes for the agent's stdin; `end` closes stdin after them. */
  write: [{ agentId: string; data: string; end?: boolean }, boolean];
  kill: [{ agentId: string; signal?: string }, boolean];
  list: [Record<string, never>, AgentRecord[]];
  /** Drops an exited agent the hub has seen exit. */
  forget: [{ agentId: string }, boolean];
  ping: [Record<string, never>, { pid: number; agents: number }];
}

export type DaemonRequestName = keyof DaemonRequests;

export type ControlRequest = {
  [K in DaemonRequestName]: { id: number; t: K } & DaemonRequests[K][0];
}[DaemonRequestName];

export type ControlNotify = { t: "shutdown" };

export type ControlReply =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

export type StreamEvent =
  /** `off` is the offset of the first byte of `d`, which is base64. */
  | { t: "out"; id: string; stream: AgentStreamName; off: number; d: string }
  | { t: "exit"; id: string; code: number | null; signal: string | null };
