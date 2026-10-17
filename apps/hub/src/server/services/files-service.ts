/**
 * The hub's files service: the shared `FilesService` (`@band-app/worktree-ops`)
 * over the hub's worktree records and host registry. A worker's direct
 * listener runs the same class over its own host.
 */

import { FilesService } from "@band-app/worktree-ops/files";

import { ephemeralLifecycleService } from "./ephemeral-lifecycle-service";
import { worktreeService } from "./worktree-service";

export { FilesService };

export const filesService = new FilesService({
  resolve: (worktreeId) => worktreeService.resolve(worktreeId),
  ensureAwake: (worktreeId) => ephemeralLifecycleService.ensureAwake(worktreeId),
});
