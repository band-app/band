import type { CIStatus, GitStatus, WorkspaceStatus } from "../types";

export type SSEEvent = {
  kind:
    | "update"
    | "remove"
    | "snapshot"
    | "branch-status"
    | "tunnel-url"
    | "tunnel-error"
    | "tunnel-subdomain-taken"
    | "tunnel-remote-host";
  status?: WorkspaceStatus;
  statuses?: WorkspaceStatus[];
  workspaceId?: string;
  git?: GitStatus;
  ci?: CIStatus;
  url?: string;
  error?: string;
  host?: string;
};
