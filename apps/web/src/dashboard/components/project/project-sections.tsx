import type { trpc } from "../../../lib/trpc-client";
import { useHostNames } from "../../hooks/use-host-names";

export type ProjectList = Awaited<ReturnType<typeof trpc.projects.list.query>>;
export type Project = ProjectList["projects"][number];

export const PROJECTS_KEY = ["projects.list"] as const;

/** The display name: the title when one is set, else the name. */
export const projectTitle = (p: { name: string; title?: string }) => p.title || p.name;

export const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function ErrorLine({ message }: { message: string | null }) {
  return message ? (
    <p role="alert" data-testid="projects__error" className="text-xs text-destructive">
      {message}
    </p>
  ) : null;
}

/** Where a repo comes from: its URL, or the one host that holds a repo with no remote. */
export function RepoLocation({
  repo,
}: {
  repo: { remoteUrl?: string; clones?: Array<{ hostId: string }> } | undefined;
}) {
  const hostName = useHostNames();
  if (!repo) return null;
  if (repo.remoteUrl) {
    return (
      <span
        className="block truncate text-xs text-muted-foreground"
        data-testid="projects__repo-url"
      >
        {repo.remoteUrl}
      </span>
    );
  }
  const host = repo.clones?.[0]?.hostId;
  return (
    <span className="block text-xs text-muted-foreground" data-testid="projects__repo-local-only">
      No remote. Lives on {host ? hostName(host) : "one host"} only, so worktrees can run only
      there.
    </span>
  );
}
