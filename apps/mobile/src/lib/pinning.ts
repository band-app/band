/** The pin request for a row, with the host left out for the hub's own machine like the web does. */
export function pinRequest(
  row: { repo: string; name: string; hostId: string },
  pinned: boolean,
): { repo: string; name: string; pinned: boolean; hostId?: string } {
  return {
    repo: row.repo,
    name: row.name,
    pinned,
    ...(row.hostId === "local" ? {} : { hostId: row.hostId }),
  };
}

interface PinnableRepo {
  name: string;
  worktrees: { name: string; hostId?: string; pinned: boolean }[];
}

/** `repos.list` with one worktree's pin flag changed, for the optimistic update. */
export function withPinned<R extends PinnableRepo>(
  repos: R[],
  request: { repo: string; name: string; pinned: boolean; hostId?: string },
): R[] {
  return repos.map((repo) =>
    repo.name !== request.repo
      ? repo
      : {
          ...repo,
          worktrees: repo.worktrees.map((w) =>
            w.name === request.name && (w.hostId ?? "local") === (request.hostId ?? "local")
              ? { ...w, pinned: request.pinned }
              : w,
          ),
        },
  );
}
