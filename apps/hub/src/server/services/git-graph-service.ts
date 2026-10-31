import { GitGraphService } from "@band-app/worktree-ops/git-graph";
import { worktreeService } from "./worktree-service";

export type {
  CommitDetails,
  CommitFileChange,
  CommitHistoryResult,
  CommitRef,
  HistoryCommit,
} from "@band-app/worktree-ops/git-graph";
export { GitGraphService };

export const gitGraphService = new GitGraphService(worktreeService);
