import {
  effectivePrimaryHost,
  isHostAllowed,
  onlyAvailableOnMessage,
} from "@band-app/shared/repo-hosts";
import { RepoHostNotAllowedError } from "../../errors";
import { RepoQueries } from "../../infra/db/queries/repos";
import { tokenService } from "../token-service";

const repoQueries = new RepoQueries();

/** The display name of each host id, falling back to the id for a host the hub no longer lists. */
export function hostNamesOf(ids: readonly string[]): string[] {
  const names = new Map(tokenService.listHosts(1000).map((h) => [h.id, h.name]));
  return ids.map((id) => names.get(id) || id);
}

/** The hosts a repo is limited to, or null when it may run anywhere (or does not exist). */
export function allowedHostsOf(repo: string): string[] | null {
  return repoQueries.findHostPolicy(repo)?.allowedHostIds ?? null;
}

/** Throws `RepoHostNotAllowedError` unless the repo may run on `hostId`. The one hard rule. */
export function assertHostAllowed(repo: string, hostId: string): void {
  const allowed = allowedHostsOf(repo);
  if (isHostAllowed(allowed, hostId)) return;
  throw new RepoHostNotAllowedError(
    onlyAvailableOnMessage(repo, hostNamesOf(allowed ?? [])),
    repo,
    allowed ?? [],
  );
}

/** A worktree row, as far as the listing rules need it. */
interface ListedRow {
  name: string;
  branch: string;
  hostId?: string | null;
}

/** Whether a row is the checkout of the repo's default branch on its host. */
function isDefaultCheckout(repo: { defaultBranch: string }, wt: ListedRow): boolean {
  return wt.name === repo.defaultBranch || wt.branch === repo.defaultBranch;
}

/**
 * The host whose default-branch checkout the repo lists as a worktree. Other hosts keep their
 * clone as a hidden cache that new worktrees are created from.
 */
export function primaryHostOf(repo: {
  defaultBranch: string;
  allowedHostIds?: string[] | null;
  primaryHostId?: string | null;
  worktrees: ListedRow[];
}): string | null {
  return effectivePrimaryHost(
    repo.primaryHostId,
    repo.allowedHostIds,
    repo.worktrees.filter((wt) => isDefaultCheckout(repo, wt)).map((wt) => wt.hostId || "local"),
  );
}

/** The worktrees a repo lists: all of them except the default-branch checkouts of non-primary hosts. */
export function listedWorktrees<T extends ListedRow>(repo: {
  defaultBranch: string;
  allowedHostIds?: string[] | null;
  primaryHostId?: string | null;
  worktrees: T[];
}): T[] {
  const primary = primaryHostOf(repo);
  return repo.worktrees.filter(
    (wt) => !isDefaultCheckout(repo, wt) || (wt.hostId || "local") === primary,
  );
}
