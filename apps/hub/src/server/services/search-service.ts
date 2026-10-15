/**
 * The hub's search service: the shared `SearchService` (`@band-app/worktree-ops`)
 * over the hub's worktree records and host registry. A worker's direct
 * listener runs the same class over its own host.
 */

import { SearchService } from "@band-app/worktree-ops/search";
import { worktreeService } from "./worktree-service";

export { SearchService };

export const searchService = new SearchService({
  resolve: (worktreeId) => worktreeService.resolve(worktreeId),
});
