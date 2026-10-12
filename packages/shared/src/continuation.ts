/**
 * Follow the work: continuing a worktree on another host when its host is offline.
 *
 * Types and small pure helpers shared by the hub and the UI. `ContinuedFrom` is stored on the
 * new copy, `Divergence` on the old copy once its host is back.
 */

/** Why a worktree was continued: a person accepted the offer, or the repo continues by itself. */
export type ContinueReason = "manual" | "auto";

/** The record a continuation leaves on the new copy. */
export interface ContinuedFrom {
  /** The host the work came from, which was offline. */
  fromHostId: string;
  /** The id of the copy that stays behind, superseded. */
  fromWorktreeId: string;
  /** The host the work continues on. */
  toHostId: string;
  /** The checkpoint the new copy was restored from. */
  checkpointId: string;
  reason: ContinueReason;
  /** Epoch ms of the continuation. */
  at: number;
  /** Epoch ms of the checkpoint, so the UI can say how old the work was. */
  checkpointAt: number;
}

/**
 * What the old host's copy holds once the host is back. `clean` means its files are the ones the
 * checkpoint holds. `diverged` means it has changes the continuation did not carry. `resolved`
 * means a person brought them over.
 */
export type DivergenceState = "clean" | "diverged" | "resolved";

export interface Divergence {
  state: DivergenceState;
  /** Epoch ms of the last comparison. */
  checkedAt: number;
  /** The checkpoint the comparison used. */
  checkpointId: string;
  /** How many files differ. Absent when unknown. */
  files?: number;
}

/** Default age under which a checkpoint is fresh enough to continue on without asking. */
export const DEFAULT_AUTO_CONTINUE_MAX_AGE_MS = 30 * 60_000;

/** What a continuation runs on the new copy. Shown in the offer and the docs. */
export const CONTINUE_RUNS = [
  "Setup runs on the new copy, if the repo has a setup script.",
] as const;

/** What a continuation does not carry over. Shown in the offer and the docs. */
export const CONTINUE_LIMITS = [
  "Ignored files (node_modules, build output, .env) are not carried over.",
  "Running processes and open terminals are not carried over.",
] as const;

/** A short age such as "4 min", "3 h", "2 d". */
export function formatAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h`;
  return `${Math.round(h / 24)} d`;
}

/** One candidate host in an offer. */
export interface ContinueTarget {
  hostId: string;
  hostName: string;
  /** The repo already has a clone on this host. */
  hasClone: boolean;
  /** The worktree's agent can start on this host. */
  agentReady: boolean;
  /** Why the agent cannot start, when it cannot. */
  agentProblem?: string;
  /** Worktrees already on the host, the "least busy" measure. */
  load: number;
  /** The host the hub would choose. */
  recommended: boolean;
}

export type ContinueBlock =
  | "restricted-to-offline-host"
  | "checkpoints-off"
  | "no-checkpoint"
  | "no-online-host"
  | "agent-unavailable"
  | "already-continued"
  | "not-offline";

export interface ContinueOffer {
  worktreeId: string;
  repo: string;
  fromHostId: string;
  fromHostName: string;
  /** Set when the work cannot continue, with a message that says why and what to do. */
  blocked?: { reason: ContinueBlock; message: string };
  checkpointId?: string;
  checkpointAt?: number;
  /** Age of the checkpoint in ms, at the time of the offer. */
  checkpointAgeMs?: number;
  targets: ContinueTarget[];
  /** The message the prompt shows. */
  question: string;
  /** What will not carry over. */
  limits: string[];
  /** What runs on the new copy, such as the repo's setup. */
  willRun: string[];
  /** The checkpoint is young enough that the repo would continue without asking, were it set to. */
  fresh: boolean;
}

/** The body the chat submit route and the tRPC calls answer with when the host is offline. */
export interface HostOfflineAnswer {
  code: "HOST_OFFLINE" | "CONTINUE_NOT_POSSIBLE";
  error: string;
  offer: ContinueOffer;
}
