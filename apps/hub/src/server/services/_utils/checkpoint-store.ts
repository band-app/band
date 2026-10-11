/** Where the hub keeps checkpoint files, and how it forgets them. */

import { rmSync } from "node:fs";
import { join } from "node:path";
import { bandHome } from "../../infra/db/queries/settings";
import { CheckpointQueries } from "../../infra/db/queries/worktree-checkpoints";

const queries = new CheckpointQueries();

/** `<BAND_HOME>/checkpoints/<worktree id>/`, holding a directory per checkpoint and the view repo. */
export function worktreeCheckpointDir(worktreeId: string): string {
  return join(bandHome(), "checkpoints", worktreeId);
}

export function checkpointDir(worktreeId: string, checkpointId: string): string {
  return join(worktreeCheckpointDir(worktreeId), checkpointId);
}

/** Deletes every checkpoint of a worktree, rows and files. Used when the worktree is removed. */
export function forgetCheckpoints(worktreeId: string): void {
  queries.deleteForWorktree(worktreeId);
  rmSync(worktreeCheckpointDir(worktreeId), { recursive: true, force: true });
}
