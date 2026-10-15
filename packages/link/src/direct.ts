/**
 * The messages of the worker's direct listener.
 *
 * A worker listens on loopback for a client on its own machine (the desktop
 * app), so terminals, files, diff and search skip the hub. The hub issues the
 * client a short-lived token and registers it here with the worktree it is
 * for. The worker keeps only the token's SHA-256.
 */

/** Hub to worker: `DirectRegisterParams` in, `DirectRegisterReply` out. */
export const METHOD_DIRECT_REGISTER = "direct.register";

/** The capability a worker with a direct listener names in its hello. */
export const CAPABILITY_DIRECT = "direct";

export interface DirectScopeParams {
  worktreeId: string;
  path: string;
  defaultBranch: string;
  repoKind?: string;
}

export interface DirectRegisterParams {
  token: string;
  scope: DirectScopeParams;
  /** How long the token lasts. The worker counts it on its own clock, up to its own ceiling. */
  ttlMs: number;
}

export interface DirectRegisterReply {
  /** The listener's port on `127.0.0.1`. */
  port: number;
  /** Epoch ms on the worker's clock after which it refuses the token. */
  expiresAt: number;
}
