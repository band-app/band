/**
 * The local direct path: the desktop app talks
 * to a worker on its own machine over `127.0.0.1` for terminals, files, diff
 * and search, with a short-lived token the hub issued. These are the wire
 * names both ends share.
 */

/** The tRPC procedures a worker's direct listener serves, by their hub path. */
export const DIRECT_PROCEDURES = [
  "worktree.listFiles",
  "worktree.getFile",
  "worktree.saveFile",
  "worktree.getDiff",
  "worktree.getChanges",
  "worktree.getFileDiff",
  "worktree.searchFiles",
  "worktree.searchContent",
] as const;

export type DirectProcedure = (typeof DIRECT_PROCEDURES)[number];

export function isDirectProcedure(path: string): path is DirectProcedure {
  return (DIRECT_PROCEDURES as readonly string[]).includes(path);
}

/** `POST <origin>/direct/<procedure>` with the input as the JSON body. */
export const DIRECT_CALL_PREFIX = "/direct/";

/** The terminal WebSocket, with `worktreeId` and `terminalId` in the query, as on the hub. */
export const DIRECT_TERMINAL_PATH = "/terminal";

/** The language server WebSocket, with `worktreeId` and `lang` in the query, as on the hub. */
export const DIRECT_LSP_PATH = "/lsp";

/**
 * The file-change WebSocket, with `worktreeId` in the query. It sends one text
 * frame per change, `{"path": "<worktree-relative parent directory>"}`, as the
 * hub's `worktree.fileChanges` subscription does, and closes with
 * {@link DIRECT_WATCH_ENDED_CLOSE_CODE} when the watch ends.
 */
export const DIRECT_WATCH_PATH = "/watch";

/** Close code of a watch socket whose watch ended (the worktree directory went away). */
export const DIRECT_WATCH_ENDED_CLOSE_CODE = 4101;

/**
 * Close code of a direct terminal socket that cannot serve the terminal (no
 * such PTY on the worker yet, or a refused token). The client falls back to
 * the hub, which spawns the terminal when it is missing.
 */
export const DIRECT_FALLBACK_CLOSE_CODE = 4100;

/** The token prefix, so a log scrubber can recognise one. */
export const DIRECT_TOKEN_PREFIX = "bwd_";

/** What `worktree.directAccess` returns for a worktree on the caller's own worker. */
export interface DirectAccess {
  hostId: string;
  /** The listener's port on `127.0.0.1`. */
  port: number;
  token: string;
  /** Epoch ms. The client asks for a new token before then. */
  expiresAt: number;
}

/** What a direct call answers with: the procedure's result, or the error the hub would have sent. */
export type DirectCallReply = { result: unknown } | { error: { message: string; code: string } };
