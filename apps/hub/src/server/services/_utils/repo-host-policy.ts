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
  return ids.map((id) => names.get(id) || (id === "local" ? "This hub" : "unknown host"));
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
  /** Set on a copy that was continued or moved to another host. */
  supersededBy?: string | null;
}

/**
 * The hosts holding a default-branch checkout. A superseded copy counts only while no live copy
 * exists, so a main continued off its primary host lists the new copy and not the old one.
 */
function defaultCheckoutHosts(repo: { defaultBranch: string; worktrees: ListedRow[] }): string[] {
  const all = repo.worktrees.filter((wt) => isDefaultCheckout(repo, wt));
  const live = all.filter((wt) => !wt.supersededBy);
  return (live.length > 0 ? live : all).map((wt) => wt.hostId || "local");
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
  return effectivePrimaryHost(repo.primaryHostId, repo.allowedHostIds, defaultCheckoutHosts(repo));
}

/**
 * The host whose default-branch checkout the repo lists. The primary host while it holds one.
 * When the primary's clone is on another branch (or the primary has no clone), another allowed
 * host that does hold the default branch, so a repo never lists no main while one exists.
 */
export function listedMainHostOf(repo: {
  defaultBranch: string;
  allowedHostIds?: string[] | null;
  primaryHostId?: string | null;
  worktrees: ListedRow[];
}): string | null {
  const withMain = defaultCheckoutHosts(repo);
  const primary = primaryHostOf(repo);
  if (primary && withMain.includes(primary)) return primary;
  return effectivePrimaryHost(null, repo.allowedHostIds, withMain);
}

/**
 * The primary host when no host lists a default-branch checkout, so the UI can show a "main is
 * not checked out on <host>" row instead of nothing. Null when a main row is listed.
 */
export function mainMissingOf(repo: {
  defaultBranch: string;
  allowedHostIds?: string[] | null;
  primaryHostId?: string | null;
  worktrees: ListedRow[];
}): { hostId: string } | null {
  if (listedMainHostOf(repo)) return null;
  const primary = primaryHostOf(repo);
  return primary ? { hostId: primary } : null;
}

/** The worktrees a repo lists: all of them except the default-branch checkouts of non-listed hosts. */
export function listedWorktrees<T extends ListedRow>(repo: {
  defaultBranch: string;
  allowedHostIds?: string[] | null;
  primaryHostId?: string | null;
  worktrees: T[];
}): T[] {
  const main = listedMainHostOf(repo);
  return repo.worktrees.filter(
    (wt) => !isDefaultCheckout(repo, wt) || (wt.hostId || "local") === main,
  );
}
