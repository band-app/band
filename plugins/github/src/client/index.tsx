import { defineClientPlugin } from "@band-app/plugin-api/client";
import { GitPullRequest } from "lucide-react";
import { PullRequestPanel } from "./PullRequestPanel";

export default defineClientPlugin({
  id: "github",
  contributions: {
    "worktree.sideTabs": [
      { id: "pull-request", label: "Checks", icon: GitPullRequest, component: PullRequestPanel },
    ],
  },
});
