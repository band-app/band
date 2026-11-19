import { ghRunner, gitRunner } from "@band-app/host-api";
import { parseGitRemoteUrl, type RepoInfo } from "@band-app/host-local/git/git-client";
import { toWorktreeId } from "@band-app/shared/worktree-id";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { WorktreeNotFoundError } from "../errors";
import { getDb } from "../infra/db/connection";
import { type PrOverride, WorktreeQueries } from "../infra/db/queries/worktrees";
import { branchStatuses } from "../infra/db/schema";
import { branchStatusPoller } from "./branch-status-poller";
import { pluginHost } from "./plugin-host-service";
import { loadState } from "./state";
import { emit } from "./watcher-service";
import { worktreeService } from "./worktree-service";

export const worktreePrInput = z.object({ worktreeId: z.string().min(1) });
export const worktreePrSetInput = worktreePrInput.extend({ url: z.string().min(1).max(500) });

/** The URL given to `pr set` is not a pull request URL. */
export class InvalidPrUrlError extends Error {
  constructor(url: string) {
    super(
      `"${url}" is not a GitHub pull request URL. Expected https://<host>/<owner>/<repo>/pull/<number>`,
    );
    this.name = "InvalidPrUrlError";
  }
}

/** Parses `https://host/owner/repo/pull/123` (optionally followed by `/files`, a query or a hash). */
export function parsePrUrl(input: string): {
  url: string;
  host: string;
  owner: string;
  repo: string;
  number: number;
} {
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    throw new InvalidPrUrlError(input);
  }
  if (parsed.protocol !== "https:") throw new InvalidPrUrlError(input);
  const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d{1,9})(?:\/.*)?$/.exec(parsed.pathname);
  if (!match) throw new InvalidPrUrlError(input);
  const [, owner, repo, num] = match;
  const number = Number(num);
  if (number < 1) throw new InvalidPrUrlError(input);
  return {
    url: `${parsed.protocol}//${parsed.host}/${owner}/${repo}/pull/${number}`,
    host: parsed.host,
    owner,
    repo,
    number,
  };
}

/** The PR is in a repo this worktree has no link to. */
export class PrRepoNotAllowedError extends Error {
  constructor(pr: string, allowed: string[]) {
    super(
      `${pr} is not in this worktree's repository, its upstream or its push remote. Allowed: ${allowed.join(", ") || "none found"}`,
    );
    this.name = "PrRepoNotAllowedError";
  }
}

const hostKey = (host: string) => host.toLowerCase().replace(/^www\./, "");
const repoKey = (r: RepoInfo) => `${hostKey(r.host)}/${r.owner}/${r.repo}`.toLowerCase();

export interface WorktreePrInfo {
  source: "detected" | "manual";
  /** The PR the badge shows, or null when the worktree has none. */
  pr: unknown | null;
  /** The CI state stored beside the PR. */
  ci: { state: string; url: string | null } | null;
  /** Who set the manual PR and when. Null for a detected one. */
  override: Pick<PrOverride, "url" | "setBy" | "setAt"> | null;
}

/** Sets, clears and reads the pull request of a worktree chosen by hand. */
export class WorktreePrService {
  constructor(private readonly queries: WorktreeQueries = new WorktreeQueries()) {}

  private requireWorktree(worktreeId: string): void {
    for (const repo of loadState().repos) {
      for (const wt of repo.worktrees) {
        if (toWorktreeId(repo.name, wt.name, wt.hostId) === worktreeId) return;
      }
    }
    throw new WorktreeNotFoundError(worktreeId);
  }

  get(worktreeId: string): WorktreePrInfo {
    this.requireWorktree(worktreeId);
    const override = this.queries.getPrOverride(worktreeId);
    const row = getDb()
      .select({
        ciPr: branchStatuses.ciPr,
        ciState: branchStatuses.ciState,
        ciUrl: branchStatuses.ciUrl,
      })
      .from(branchStatuses)
      .where(eq(branchStatuses.worktreeId, worktreeId))
      .get();
    return {
      source: override ? "manual" : "detected",
      pr: row?.ciPr ?? null,
      ci: row ? { state: row.ciState, url: row.ciUrl } : null,
      override: override
        ? { url: override.url, setBy: override.setBy, setAt: override.setAt }
        : null,
    };
  }

  async set(worktreeId: string, url: string, setBy: string): Promise<WorktreePrInfo> {
    const parsed = parsePrUrl(url);
    this.requireWorktree(worktreeId);
    await this.assertRepoAllowed(worktreeId, parsed);
    this.queries.setPrOverride(worktreeId, {
      url: parsed.url,
      owner: parsed.owner,
      repo: parsed.repo,
      number: parsed.number,
      setBy,
      setAt: Date.now(),
    });
    return this.refreshed(worktreeId);
  }

  /**
   * A manual PR must live in the worktree's own repository (`origin`), its upstream (the repo it
   * was forked from) or the repo its branch pushes to. When a repo cannot be read, the others
   * still count.
   */
  private async assertRepoAllowed(
    worktreeId: string,
    pr: { host: string; owner: string; repo: string; url: string },
  ): Promise<void> {
    const resolved = worktreeService.resolve(worktreeId);
    if (!resolved) throw new WorktreeNotFoundError(worktreeId);
    const { host, worktree } = resolved;
    const cwd = worktree.path;
    const run = gitRunner(host);
    const allowed = new Map<string, RepoInfo>();
    const add = (info: RepoInfo | null) => {
      if (info) allowed.set(repoKey(info), info);
    };
    const remoteInfo = async (name: string): Promise<RepoInfo | null> => {
      try {
        return parseGitRemoteUrl((await run(["remote", "get-url", name], cwd)).trim());
      } catch {
        return null;
      }
    };
    const config = async (key: string): Promise<string | null> => {
      try {
        return (await run(["config", "--get", key], cwd)).trim() || null;
      } catch {
        return null;
      }
    };
    const origin = await remoteInfo("origin");
    add(origin);
    const pushRemote =
      (await config(`branch.${worktree.branch}.pushRemote`)) ??
      (await config("remote.pushDefault")) ??
      (await config(`branch.${worktree.branch}.remote`));
    if (pushRemote) add(await remoteInfo(pushRemote));
    if (origin && !allowed.has(repoKey({ ...pr, host: pr.host }))) {
      const provider = await pluginHost.branchStatusProviderFor(origin);
      if (provider?.getParentRepo) {
        try {
          add(
            await provider.getParentRepo(origin, { cwd, gh: (args) => ghRunner(host)(args, cwd) }),
          );
        } catch {
          // The forge cannot be reached: the repos known from git still count.
        }
      }
    }
    if (!allowed.has(repoKey(pr))) {
      throw new PrRepoNotAllowedError(
        `${pr.owner}/${pr.repo}`,
        [...allowed.values()].map((r) => `${r.owner}/${r.repo}`),
      );
    }
  }

  async clear(worktreeId: string): Promise<WorktreePrInfo> {
    this.requireWorktree(worktreeId);
    this.queries.clearPrOverride(worktreeId);
    return this.refreshed(worktreeId);
  }

  private async refreshed(worktreeId: string): Promise<WorktreePrInfo> {
    await branchStatusPoller.refreshWorktreeCI(worktreeId);
    emit({ kind: "review-changed", worktreeIds: [worktreeId] });
    return this.get(worktreeId);
  }
}

export const worktreePrService = new WorktreePrService();
