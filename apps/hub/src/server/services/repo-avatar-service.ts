import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gitRunner } from "@band-app/host-api";
import { getRepoInfo } from "@band-app/host-local/git/git-client";
import { createLogger } from "@band-app/logger";
import { RepoQueries, type RepoState } from "../infra/db/queries/repos";
import { bandHome } from "../infra/db/queries/settings";
import { GitHubClient } from "../infra/github/github-client";
import { type GitHubRepoRef, githubRepoRef } from "../infra/github/github-repo-ref";
import { hostRegistry } from "../infra/host/registry";

const log = createLogger("repo-avatars");

/** How long a fetched avatar (or a confirmed "no avatar") is reused before
 *  the next request refetches it. Owners rarely change their picture. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** After a failed fetch (offline, timeout, 5xx), wait this long before
 *  trying GitHub again, so a sidebar re-render or the 30 s repo-list
 *  refetch does not retry on every request. */
const FAILURE_BACKOFF_MS = 5 * 60 * 1000;
/** `git remote get-url origin` result reuse. `repos.list` runs every
 *  30 s per open dashboard; a remote change shows up within a minute. */
const REMOTE_TTL_MS = 60 * 1000;

/** What `repos.list` returns per repo for the UI to render. */
export interface RepoAvatarInfo {
  /** Same-origin URL of the cached image. */
  src: string;
  /** `owner/repo`, for alt text. */
  label: string;
}

/** On-disk sidecar describing one cached owner avatar. */
interface CacheMeta {
  status: "ok" | "missing";
  contentType?: string;
  fetchedAt: number;
}

interface CacheEntry {
  meta: CacheMeta | null;
  /** Epoch ms before which a failed fetch is not retried. */
  retryAfter: number;
}

interface AvatarImage {
  bytes: Buffer;
  contentType: string;
}

/**
 * Owner avatars for repos whose `origin` is on GitHub.
 *
 * The image is fetched once per owner and cached under
 * `~/.band/cache/github-avatars/`, so the browser only ever talks to Band.
 * A cached image is served even when it is stale and GitHub is unreachable.
 * A "no avatar" answer (404, non-raster type) is remembered for the TTL, and
 * `repos.list` then returns no avatar so the UI keeps its folder icon
 * without making a request.
 */
export class RepoAvatarService {
  private readonly remotes = new Map<string, { ref: GitHubRepoRef | null; at: number }>();
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<AvatarImage | null>>();

  constructor(
    private readonly queries: RepoQueries = new RepoQueries(),
    private readonly github: GitHubClient = new GitHubClient(),
  ) {}

  /**
   * Avatar descriptor for `repos.list`. Never touches the network: it
   * reads the `origin` remote (memoised) and the cache sidecar only.
   */
  async describe(repo: Pick<RepoState, "name" | "path" | "kind">): Promise<RepoAvatarInfo | null> {
    if (repo.kind !== "git") return null;
    const ref = await this.repoRef(repo.name, repo.path);
    if (!ref) return null;
    const entry = await this.entry(ref);
    if (entry.meta?.status === "missing" && !this.isStale(entry.meta)) return null;
    return {
      src: `/api/repo-avatar/${encodeURIComponent(repo.name)}`,
      label: `${ref.owner}/${ref.repo}`,
    };
  }

  /**
   * The avatar bytes for the repo named `repoName`, fetching and
   * caching them on a miss. `null` when the repo is unknown, not on
   * GitHub, has no avatar, or GitHub is unreachable with nothing cached.
   */
  async image(repoName: string): Promise<AvatarImage | null> {
    const repo = this.queries.findLocation(repoName);
    if (!repo || repo.kind !== "git") return null;
    const ref = await this.repoRef(repoName, repo.path);
    if (!ref) return null;

    const key = cacheKey(ref);
    const entry = await this.entry(ref);
    if (entry.meta && !this.isStale(entry.meta)) return this.readCached(key, entry.meta);
    if (Date.now() < entry.retryAfter) return this.readCached(key, entry.meta);

    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.refresh(ref, entry).finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    return pending;
  }

  private async refresh(ref: GitHubRepoRef, entry: CacheEntry): Promise<AvatarImage | null> {
    const key = cacheKey(ref);
    try {
      const result = await this.github.fetchAvatar(ref);
      if (result.kind === "unavailable") {
        log.debug("avatar for %s/%s unavailable: %s", ref.host, ref.owner, result.reason);
        entry.retryAfter = Date.now() + FAILURE_BACKOFF_MS;
        return this.readCached(key, entry.meta);
      }
      if (result.kind === "missing") {
        await this.writeMeta(key, entry, { status: "missing", fetchedAt: Date.now() });
        return null;
      }
      await mkdir(cacheDir(), { recursive: true });
      // Write to a temp name and rename so a concurrent reader never sees a
      // half-written image.
      const imagePath = join(cacheDir(), `${key}.img`);
      await writeFile(`${imagePath}.tmp`, result.bytes);
      await rename(`${imagePath}.tmp`, imagePath);
      await this.writeMeta(key, entry, {
        status: "ok",
        contentType: result.contentType,
        fetchedAt: Date.now(),
      });
      return { bytes: result.bytes, contentType: result.contentType };
    } catch (err) {
      // Cache directory not writable, disk full: back off like a network
      // failure and keep serving whatever is cached.
      log.debug("avatar cache write for %s failed: %s", key, err);
      entry.retryAfter = Date.now() + FAILURE_BACKOFF_MS;
      return this.readCached(key, entry.meta);
    }
  }

  private async readCached(key: string, meta: CacheMeta | null): Promise<AvatarImage | null> {
    if (meta?.status !== "ok" || !meta.contentType) return null;
    try {
      const bytes = await readFile(join(cacheDir(), `${key}.img`));
      return { bytes, contentType: meta.contentType };
    } catch {
      return null;
    }
  }

  private async writeMeta(key: string, entry: CacheEntry, meta: CacheMeta): Promise<void> {
    entry.meta = meta;
    entry.retryAfter = 0;
    await mkdir(cacheDir(), { recursive: true });
    await writeFile(join(cacheDir(), `${key}.json`), JSON.stringify(meta));
  }

  /** In-memory view of one owner's cache sidecar, loaded from disk once. */
  private async entry(ref: GitHubRepoRef): Promise<CacheEntry> {
    const key = cacheKey(ref);
    let entry = this.entries.get(key);
    if (entry) return entry;
    let meta: CacheMeta | null = null;
    try {
      meta = JSON.parse(await readFile(join(cacheDir(), `${key}.json`), "utf-8")) as CacheMeta;
    } catch {
      // No sidecar yet, or a corrupt one: treat as a cache miss.
    }
    // Another caller may have populated the entry while we awaited the read.
    entry = this.entries.get(key) ?? { meta, retryAfter: 0 };
    this.entries.set(key, entry);
    return entry;
  }

  private isStale(meta: CacheMeta): boolean {
    return Date.now() - meta.fetchedAt > CACHE_TTL_MS;
  }

  private async repoRef(repoName: string, repoPath: string): Promise<GitHubRepoRef | null> {
    const cached = this.remotes.get(repoPath);
    if (cached && Date.now() - cached.at < REMOTE_TTL_MS) return cached.ref;
    const ref = githubRepoRef(
      await getRepoInfo(repoPath, gitRunner(hostRegistry.hostForRepo(repoName))),
    );
    this.remotes.set(repoPath, { ref, at: Date.now() });
    return ref;
  }
}

function cacheDir(): string {
  return join(bandHome(), "cache", "github-avatars");
}

/** The avatar belongs to the owner, so every repo of one owner shares it.
 *  Logins are case-insensitive; a GHES port separator becomes `_`. */
function cacheKey(ref: Pick<GitHubRepoRef, "host" | "owner">): string {
  return `${ref.host.replace(/[^a-z0-9.-]/g, "_")}__${ref.owner.toLowerCase()}`;
}

export const repoAvatarService = new RepoAvatarService();
