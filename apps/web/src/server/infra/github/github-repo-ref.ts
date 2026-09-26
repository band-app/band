import type { RepoInfo } from "../git/git-client";

/**
 * GitHub coordinates of a project's `origin`, normalised for avatar
 * lookups. `host` is lower-cased; `owner` / `repo` keep their case so the
 * `owner/repo` label reads the way GitHub shows it.
 */
export interface GitHubRepoRef {
  host: string;
  owner: string;
  repo: string;
}

// github.com accepts these as aliases of itself: `www.` over HTTPS and
// `ssh.github.com` for SSH over port 443.
const GITHUB_COM_ALIASES = new Set(["github.com", "www.github.com", "ssh.github.com"]);

// GitHub logins are alphanumerics and hyphens; GitHub Enterprise managed
// users add `_<shortcode>`. Anything else (dots, slashes, `..`) is not a
// login and must never reach a URL path or a cache file name.
const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

/**
 * Decide whether a parsed `origin` remote points at GitHub, and if so return
 * the host the avatar is served from.
 *
 * github.com and its aliases map to `github.com`. GitHub Enterprise Server
 * hosts are recognised only by name, because that is free: the conventional
 * `github.<company>.<tld>` pattern and GitHub Enterprise Cloud's
 * `<subdomain>.ghe.com`. Any other host (GitLab, Bitbucket, a GHES instance
 * on an unconventional name) gets no avatar rather than a request to a server
 * that may not serve `/<owner>.png`.
 */
export function githubRepoRef(info: RepoInfo | null): GitHubRepoRef | null {
  if (!info) return null;
  const host = info.host.toLowerCase();
  if (!OWNER_PATTERN.test(info.owner)) return null;
  if (GITHUB_COM_ALIASES.has(host)) {
    return { host: "github.com", owner: info.owner, repo: info.repo };
  }
  if (host.startsWith("github.") || host.endsWith(".ghe.com")) {
    return { host, owner: info.owner, repo: info.repo };
  }
  return null;
}
