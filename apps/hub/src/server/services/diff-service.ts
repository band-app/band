/**
 * The hub's diff service: the shared `DiffService` (`@band-app/worktree-ops`)
 * over the hub's worktree records and host registry. A worker's direct
 * listener runs the same class over its own host.
 */

import { DiffService } from "@band-app/worktree-ops/diff";
import { worktreeService } from "./worktree-service";

export { DiffService };

export const diffService = new DiffService({
  resolve: (worktreeId) => worktreeService.resolve(worktreeId),
});
